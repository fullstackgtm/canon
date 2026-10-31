/**
 * What a meeting suggests adding to the CRM: the people from the other side
 * who are not in it yet, their company when it is not either, and a deal when
 * no open deal matched and the call quotes a real opportunity. Nothing here is
 * created: each suggestion waits for the person whose meeting it was
 * (convex/callSuggestions.ts).
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "./granola.ts";
import type { CompanyIdentity, Identity, NamedPerson } from "./whoIs.ts";

export type SuggestionKind = "account" | "contact" | "deal";

export type SuggestionValues = {
  name?: string;
  domain?: string;
  email?: string;
  title?: string;
  linkedinUrl?: string;
  /** A person's employer as research found it. */
  companyName?: string;
  /** Deals: cents. */
  amount?: number;
  closeDate?: string;
  nextStep?: string;
};

/** One suggestion: `key` makes it unique per workspace (a domain, an email, or the call for a deal). */
export type PlannedSuggestion = {
  kind: SuggestionKind; key: string; values: SuggestionValues; evidence?: string;
  research?: { status: "found" | "not_found"; at: number; quote?: string; sourceUrl?: string };
};

/** A person from the other side of the call. */
export type Attendee = { email: string; name: string | null };

/** What the model read for suggestions (the optional parts of the call-facts answer), already checked against the call. */
export type ReadForSuggestions = {
  /** Company names the call or the attendees give, by domain. */
  companyNames: Record<string, string>;
  /** Job titles stated on the call, by lowercased email, with the quote. */
  titles: Record<string, { value: string; evidence: string }>;
  /** A new opportunity the call quotes, when no open deal matched. */
  opportunity: { name: string; amount?: number; closeDate?: string; nextStep?: string; evidence: string } | null;
  /** The other company and its people the meeting names, quoted (lib/conversations/facts.ts). */
  mentioned?: {
    company: { name: string; searchHint: string; evidence: string } | null;
    people: Array<{ name: string; evidence: string }>;
  };
};

/** `atlascloud.example` → `Atlascloud`: a company's name when nothing better is known. */
export function nameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The suggestions for one meeting. `attendees` are the other side's people
 * (lib/calls/granola.ts externalParticipants); `knownEmails` and
 * `knownDomains` are the contacts and companies the CRM already has among
 * them. A person needs a name to be suggested: an address alone is not a
 * contact. A deal is suggested only when no open deal matched (`hasDeal`),
 * the meeting is recent, and the model quoted an opportunity.
 */
export function planSuggestions(args: {
  callKey: string;
  attendees: readonly Attendee[];
  knownEmails: ReadonlySet<string>;
  knownDomains: ReadonlySet<string>;
  hasDeal: boolean;
  recent: boolean;
  read: ReadForSuggestions;
  /** The other side's company domains on the meeting (free mail excluded), known to the CRM or not. */
  meetingDomains?: readonly string[];
  /** Who people on personal email are, by lowercased email, where research found them; `researched` lists everyone it looked for. */
  identities?: Readonly<Record<string, Identity>>;
  /** The company and people the meeting named, as research placed them (convex/callFactActions.ts). */
  mentions?: { name: string; company: CompanyIdentity | null; evidence: string; people: Array<{ name: string; evidence: string; found?: NamedPerson | null }> } | null;
  researched?: ReadonlySet<string>;
  now?: number;
}): PlannedSuggestion[] {
  const out: PlannedSuggestion[] = [];
  const newPeople = args.attendees.filter((a) => a.name && !args.knownEmails.has(a.email.toLowerCase()));
  const domains = new Set<string>();
  for (const a of args.attendees) {
    const domain = domainOfEmail(a.email);
    if (!FREE_EMAIL_DOMAINS.has(domain) && !args.knownDomains.has(domain)) domains.add(domain);
  }
  // A company is suggested for the new people at it, or when it is the only sign of who the meeting was with.
  for (const domain of domains) {
    if (!newPeople.some((p) => domainOfEmail(p.email) === domain) && args.knownEmails.size) continue;
    out.push({ kind: "account", key: domain, values: { domain, name: args.read.companyNames[domain] ?? nameFromDomain(domain) } });
  }
  // Every person in the CRM belongs to a company. Someone on personal email joins the employer research found
  // for them (lib/calls/whoIs.ts), else the meeting's one other company. With neither they are still suggested,
  // without a company: the panel offers to research them, and adding them waits until one is found.
  const meetingCompanies = [...new Set((args.meetingDomains ?? []).map((d) => d.toLowerCase()))];
  for (const p of newPeople) {
    const email = p.email.toLowerCase();
    const title = args.read.titles[email];
    const own = domainOfEmail(email);
    const found = FREE_EMAIL_DOMAINS.has(own) ? args.identities?.[email] : undefined;
    const researched = FREE_EMAIL_DOMAINS.has(own) && args.researched?.has(email);
    const domain = !FREE_EMAIL_DOMAINS.has(own) ? own : found ? found.companyDomain : meetingCompanies.length === 1 ? meetingCompanies[0] : undefined;
    out.push({
      kind: "contact", key: email,
      values: {
        email, name: found && !p.name!.includes(" ") ? found.fullName : p.name!,
        ...(domain ? { domain } : {}),
        ...(found ? { companyName: found.companyName, ...(found.linkedinUrl ? { linkedinUrl: found.linkedinUrl } : {}) } : {}),
        ...(title ? { title: title.value } : found?.title ? { title: found.title } : {}),
      },
      ...(title ? { evidence: title.evidence } : {}),
      ...(found
        ? { research: { status: "found" as const, at: args.now ?? 0, quote: found.quote, sourceUrl: found.sourceUrl } }
        : researched ? { research: { status: "not_found" as const, at: args.now ?? 0 } } : {}),
    });
  }
  // The company the meeting named and the people it named there (Granola listed none of them with an address),
  // once research confirmed the company's website. A person research could not place keeps the name the meeting used.
  const m = args.mentions;
  const mDomain = m?.company?.companyDomain;
  const mName = m?.company?.companyName ?? m?.name;
  if (m && !(mDomain && args.knownDomains.has(mDomain))) {
    const key = mDomain ?? `named:${m.name.toLowerCase()}`;
    if (!out.some((x) => x.kind === "account" && x.key === key)) {
      out.push({
        kind: "account", key,
        // Unidentified (an ambiguous short name, "Example Buyer"): suggested by the meeting's name, and the panel asks for its website.
        values: { name: mName!, ...(mDomain ? { domain: mDomain } : {}) },
        evidence: m.evidence,
        research: m.company ? { status: "found", at: args.now ?? 0, quote: m.company.quote, sourceUrl: m.company.sourceUrl } : { status: "not_found", at: args.now ?? 0 },
      });
    }
  }
  for (const pp of m?.people ?? []) {
    const name = pp.found?.fullName ?? pp.name;
    out.push({
      kind: "contact", key: `named:${(mDomain ?? m!.name).toLowerCase()}:${name.toLowerCase()}`,
      values: {
        name, companyName: mName!, ...(mDomain ? { domain: mDomain } : {}),
        ...(pp.found?.title ? { title: pp.found.title } : {}), ...(pp.found?.linkedinUrl ? { linkedinUrl: pp.found.linkedinUrl } : {}),
      },
      evidence: pp.evidence,
      research: pp.found ? { status: "found", at: args.now ?? 0, quote: pp.found.quote, sourceUrl: pp.found.sourceUrl } : { status: "not_found", at: args.now ?? 0 },
    });
  }
  // A deal: no open deal matched and the call quotes a real opportunity, at any age within the lookback (the
  // panel shows the meeting's date). Field updates stay limited to recent meetings; a suggestion is reviewed.
  const o = args.read.opportunity;
  if (o && !args.hasDeal) {
    out.push({
      kind: "deal", key: `call:${args.callKey}`,
      values: { name: o.name, ...(o.amount !== undefined ? { amount: o.amount } : {}), ...(o.closeDate ? { closeDate: o.closeDate } : {}), ...(o.nextStep ? { nextStep: o.nextStep } : {}) },
      evidence: o.evidence,
    });
  }
  return out;
}

/**
 * What a meeting is read for, by version. A workspace whose meetings were read under an older version has
 * them read again once (convex/granolaActions.ts). 2: companies, people and deals named in the meeting, at any age.
 */
export const SUGGEST_VERSION = 2;

/** Who counts as our side of a meeting: the workspace's members, their company domains, and what an admin added (`ourTeam`). */
export type Team = { emails: ReadonlySet<string>; domains: ReadonlySet<string> };

/** At most this many extra emails or domains a workspace counts as its team. */
export const OUR_TEAM_MAX = 20;

/** A valid "our team" entry, lowercased: an email or a bare domain; null otherwise. */
export function teamEntry(raw: string): string | null {
  const e = raw.trim().toLowerCase().replace(/^@/, "");
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return e;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) return e;
  return null;
}

export function teamOf(memberEmails: readonly string[], ourTeam: readonly string[]): Team {
  const emails = new Set([...memberEmails.map((e) => e.toLowerCase()), ...ourTeam.filter((e) => e.includes("@"))]);
  const domains = new Set([
    ...memberEmails.map((e) => domainOfEmail(e)).filter((d) => !FREE_EMAIL_DOMAINS.has(d)),
    ...ourTeam.filter((e) => !e.includes("@")),
  ]);
  return { emails, domains };
}

export const isOurSide = (team: Team, email: string) => team.emails.has(email.toLowerCase()) || team.domains.has(domainOfEmail(email));

/** The team as addresses for externalParticipants, which reads its internal domains from addresses. */
export const teamAddresses = (team: Team) => [...team.emails, ...[...team.domains].map((d) => `team@${d}`)];

/** Why a meeting suggested what it did, for the Granola page. */
export type SuggestionReason = "suggested" | "not_our_meeting" | "no_one_else" | "all_known";

export function suggestionReason(a: { ourMeeting: boolean; others: number; planned: number }): SuggestionReason {
  if (!a.ourMeeting) return "not_our_meeting";
  if (a.planned) return "suggested";
  return a.others ? "all_known" : "no_one_else";
}
