/**
 * The company and people a deal is missing, proposed from what Canon already holds: the CRM (the companies of
 * the deal's people, a company named like the deal, the people of its company) and the owner's conversations and
 * meetings around it (their other side's addresses). Nothing is created here: each proposal waits in
 * callSuggestions for someone to accept it (convex/dealGaps.ts). A web search runs only when a person asks for it
 * (convex/dealGapActions.ts search).
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "../calls/granola.ts";
import { nameFromDomain } from "../calls/suggestions.ts";

/** People proposed for one deal at a time: a reviewer picks from a short list. */
export const GAP_PEOPLE_MAX = 6;
/** Companies proposed for one deal at a time. */
export const GAP_COMPANIES_MAX = 4;

/** A conversation or meeting of the deal owner's, with the other side's people. */
export type GapSource = {
  kind: "email" | "linkedin" | "call";
  /** A callRecordings or conversations id. */
  id: string;
  title: string;
  at: number;
  revision?: number;
  /** The CRM people it is already linked to. */
  contactIds: readonly string[];
  people: ReadonlyArray<{ email?: string; name?: string; linkedinUrl?: string }>;
  /** A meeting logged on the deal itself. */
  onDeal?: boolean;
};

export type GapProposal = {
  kind: "account" | "contact";
  /** Unique per deal: the proposal is made once, and a dismissal sticks. */
  key: string;
  values: { name?: string; domain?: string; email?: string; title?: string; linkedinUrl?: string; companyName?: string };
  /** The CRM record it links, when the CRM has it already. */
  matchId?: string;
  /** Why: the people, the thread or the search it came from. */
  evidence: string;
  via: "crm" | "email" | "linkedin" | "call" | "search";
  source?: { kind: "email" | "linkedin" | "call"; id: string };
};

/** "AC Pools Services – pool maintenance" → "AC Pools Services": the part of a deal's name that names the customer. */
export function coreName(dealName: string): string {
  return dealName.split(/\s+[-–—|:/]\s+|\s*[(:]\s*/)[0]!.trim();
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const LEGAL = /\b(inc|llc|ltd|co|corp|corporation|company|services?|group|gmbh|limited)\b\.?/gi;

/** Whether a company name or domain label is the deal's customer: the compacted names agree, legal words aside. */
export function namesMatch(dealName: string, other: string): boolean {
  const a = compact(coreName(dealName).replace(LEGAL, ""));
  const b = compact(other.replace(/\.[a-z.]+$/i, "").replace(LEGAL, ""));
  if (a.length < 3 || b.length < 3) return false;
  return a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));
}

/** Whether a conversation or meeting is about the deal: it is with the deal's people, at its company, or names it. */
export function sourceMatches(deal: { name: string; contactIds: readonly string[]; companyDomain: string | null }, s: GapSource): boolean {
  if (s.onDeal || s.contactIds.some((id) => deal.contactIds.includes(id))) return true;
  const domains = s.people.flatMap((p) => (p.email ? [domainOfEmail(p.email)] : [])).filter((d) => !FREE_EMAIL_DOMAINS.has(d));
  if (deal.companyDomain && domains.includes(deal.companyDomain)) return true;
  if (domains.some((d) => namesMatch(deal.name, d))) return true;
  const core = coreName(deal.name).toLowerCase();
  return core.length >= 4 && s.title.toLowerCase().includes(core);
}

const listNames = (names: string[]) => (names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and "));
const SOURCE_NAME = { email: "Email", linkedin: "LinkedIn conversation", call: "Meeting" } as const;

/**
 * The proposals for one deal. `people` are the deal's people as the CRM has them; `companies` the CRM's
 * companies by id (the people's companies and those named like the deal); `knownDomains` and `knownEmails` the
 * CRM's records among the sources' addresses; `companyPeople` the people of the deal's company. `sources` are
 * already the ones about the deal (sourceMatches), newest first; `ourSide` says who of a source is on our team.
 */
export function planGaps(a: {
  deal: { name: string; companyId: string | null; companyName: string | null };
  people: ReadonlyArray<{ id: string; name: string; accountId: string | null }>;
  companies: ReadonlyMap<string, { name: string; domain: string | null }>;
  namedLike: readonly string[];
  knownDomains: ReadonlyMap<string, string>;
  knownEmails: ReadonlyMap<string, { id: string; name: string }>;
  companyPeople: ReadonlyArray<{ id: string; name: string; title: string | null }>;
  sources: readonly GapSource[];
  ourSide: (email: string) => boolean;
}): GapProposal[] {
  const out: GapProposal[] = [];
  const hasPeople = a.people.length > 0;

  if (!a.deal.companyId) {
    const seen = new Set<string>();
    const add = (p: GapProposal) => {
      const id = p.matchId ?? p.values.domain ?? p.key;
      if (seen.has(id) || seen.size >= GAP_COMPANIES_MAX) return;
      seen.add(id);
      out.push(p);
    };
    // The deal's people's own company: the strongest sign there is.
    const byCompany = new Map<string, string[]>();
    for (const p of a.people) if (p.accountId && a.companies.has(p.accountId)) byCompany.set(p.accountId, [...(byCompany.get(p.accountId) ?? []), p.name]);
    for (const [id, names] of [...byCompany].sort((x, y) => y[1].length - x[1].length)) {
      const c = a.companies.get(id)!;
      add({ kind: "account", key: `match:${id}`, matchId: id, values: { name: c.name, ...(c.domain ? { domain: c.domain } : {}) }, via: "crm", evidence: `${listNames(names)} on this deal ${names.length === 1 ? "works" : "work"} here` });
    }
    for (const id of a.namedLike) {
      const c = a.companies.get(id);
      if (c) add({ kind: "account", key: `match:${id}`, matchId: id, values: { name: c.name, ...(c.domain ? { domain: c.domain } : {}) }, via: "crm", evidence: "In your CRM under the deal's name" });
    }
    // The other side's company domains in the deal's conversations and meetings: in the CRM or new.
    for (const s of a.sources) {
      for (const p of s.people) {
        if (!p.email || a.ourSide(p.email)) continue;
        const domain = domainOfEmail(p.email);
        if (FREE_EMAIL_DOMAINS.has(domain)) continue;
        const known = a.knownDomains.get(domain);
        const evidence = `${SOURCE_NAME[s.kind]} “${s.title}” with ${p.name ?? p.email}`;
        if (known) add({ kind: "account", key: `match:${known}`, matchId: known, values: { domain, name: a.companies.get(known)?.name ?? nameFromDomain(domain) }, via: s.kind, evidence, source: { kind: s.kind, id: s.id } });
        else add({ kind: "account", key: `domain:${domain}`, values: { domain, name: nameFromDomain(domain) }, via: s.kind, evidence, source: { kind: s.kind, id: s.id } });
      }
    }
  }

  if (!hasPeople) {
    const seen = new Set<string>();
    const add = (p: GapProposal) => {
      if (seen.has(p.key) || seen.size >= GAP_PEOPLE_MAX) return;
      seen.add(p.key);
      out.push(p);
    };
    // The people of the deal's sources first: they are the ones in the conversation.
    for (const s of a.sources) {
      for (const p of s.people) {
        if (p.email && a.ourSide(p.email)) continue;
        const email = p.email?.toLowerCase();
        const known = email ? a.knownEmails.get(email) : undefined;
        const evidence = `${SOURCE_NAME[s.kind]} “${s.title}”`;
        const source = { kind: s.kind, id: s.id };
        if (known) add({ kind: "contact", key: `match:${known.id}`, matchId: known.id, values: { name: known.name, email }, via: s.kind, evidence, source });
        else if (p.name && (email || p.linkedinUrl)) {
          const domain = email ? domainOfEmail(email) : undefined;
          add({
            kind: "contact", key: email ? `email:${email}` : `linkedin:${p.linkedinUrl}`, via: s.kind, evidence, source,
            values: { name: p.name, ...(email ? { email } : {}), ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}), ...(domain && !FREE_EMAIL_DOMAINS.has(domain) ? { domain } : {}) },
          });
        }
      }
    }
    for (const p of a.companyPeople) {
      add({ kind: "contact", key: `match:${p.id}`, matchId: p.id, values: { name: p.name, ...(p.title ? { title: p.title } : {}) }, via: "crm", evidence: `Works at ${a.deal.companyName ?? "the deal's company"}` });
    }
  }
  return out;
}
