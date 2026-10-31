import { domainKey, domainFamily, nameKey } from "./duplicates.ts";
import { domainOfEmail } from "./leadConversion.ts";

export type InboundMatchInput = { email: string; companyName?: string };
export type MatchCompany = { id: string; name: string; domain?: string | null; ownerId?: string | null };
export type MatchPerson = { id: string; email?: string | null; additionalEmails?: readonly string[] | null; accountId?: string | null };
export type MatchLead = { id: string; email?: string | null };
export type MatchCandidate = { object: "company" | "person" | "lead"; id: string; reason: "email" | "domain" | "domain_family" | "name" };
export type InboundMatch =
  | { by: "none" | "ambiguous"; candidates: MatchCandidate[] }
  | { by: "email"; personId: string; companyId?: string; accountOwner?: string; candidates: MatchCandidate[] }
  | { by: "email"; leadId: string; candidates: MatchCandidate[] }
  | { by: "domain" | "domain_family"; companyId: string; accountOwner?: string; candidates: MatchCandidate[] };

export const MATCH_SCAN_MAX = 50_000;
export const MATCH_CANDIDATES_MAX = 50;

export function inboundMatchInput(input: InboundMatchInput): InboundMatchInput {
  const email = input.email.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(email)) throw new Error("Enter a valid email address.");
  if (input.companyName !== undefined && input.companyName.length > 200) throw new Error("Company name is too long.");
  return { email, ...(input.companyName?.trim() ? { companyName: input.companyName.trim() } : {}) };
}

/** The duplicate keys decide identity; a company name alone is only a review candidate. */
export function matchInbound(input: InboundMatchInput, companies: readonly MatchCompany[], people: readonly MatchPerson[], leads: readonly MatchLead[]): InboundMatch {
  const { email, companyName } = inboundMatchInput(input);
  if ([companies, people, leads].some((rows) => rows.length > MATCH_SCAN_MAX)) throw new Error("Inbound matching exceeds its record limit.");
  const candidates = (rows: MatchCandidate[]) => {
    if (rows.length > MATCH_CANDIDATES_MAX) throw new Error("Inbound matching has too many candidates to decide safely.");
    return rows.sort((a, b) => a.object.localeCompare(b.object) || a.id.localeCompare(b.id));
  };
  const sameEmail = (raw: string | null | undefined) => raw?.trim().toLowerCase() === email;
  const contacts = people.filter((p) => [p.email, ...(p.additionalEmails ?? [])].some(sameEmail));
  const matchingLeads = leads.filter((l) => sameEmail(l.email));
  const exact = candidates([
    ...contacts.map((p): MatchCandidate => ({ object: "person", id: p.id, reason: "email" })),
    ...matchingLeads.map((l): MatchCandidate => ({ object: "lead", id: l.id, reason: "email" })),
  ]);
  if (exact.length > 1) return { by: "ambiguous", candidates: exact };
  if (contacts.length === 1) {
    const person = contacts[0];
    const company = companies.find((c) => c.id === person.accountId);
    return { by: "email", personId: person.id, ...(company ? { companyId: company.id, ...(company.ownerId ? { accountOwner: company.ownerId } : {}) } : {}), candidates: exact };
  }
  if (matchingLeads.length === 1) return { by: "email", leadId: matchingLeads[0].id, candidates: exact };
  const domain = domainOfEmail(email);
  if (domain) {
    for (const reason of ["domain", "domain_family"] as const) {
      const matches = companies.filter((c) => reason === "domain" ? domainKey(c.domain) === domainKey(domain) : domainFamily(c.domain) === domainFamily(domain));
      const found = candidates(matches.map((c) => ({ object: "company", id: c.id, reason })));
      if (matches.length > 1) return { by: "ambiguous", candidates: found };
      if (matches.length === 1) {
        const company = matches[0];
        return { by: reason, companyId: company.id, ...(company.ownerId ? { accountOwner: company.ownerId } : {}), candidates: found };
      }
    }
  }
  const name = nameKey(companyName);
  return { by: "none", candidates: candidates(name ? companies.filter((c) => nameKey(c.name) === name).map((c) => ({ object: "company", id: c.id, reason: "name" })) : []) };
}
