/**
 * The free people sources CRM population draws from, behind one shape. Each
 * source turns the ICP into its own query, pages through it, and (when it
 * caps a single query) splits it into narrower ones. People from every source
 * land in the same CRM, deduplicated there (accounts by domain; contacts by
 * email, LinkedIn URL, then account + name).
 */
import type { AccountInput, ContactInput } from "./recordContract.ts";

export type Person = {
  fullName: string;
  title?: string;
  headline?: string;
  linkedinUrl?: string;
  company: { domain: string; name?: string; industry?: string; employees?: number; country?: string };
};

export type SourceId = "leadsforge" | "quickenrich";

export function normDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
}

export function nameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * People -> one account per company domain plus a contact each. `derivedNames`
 * lists accounts whose name was guessed from the domain (the source gave none),
 * for a later lookup of the real name.
 */
export function peopleToRecords(people: Person[]): { accounts: AccountInput[]; contacts: ContactInput[]; derivedNames: string[] } {
  const accounts = new Map<string, AccountInput>();
  const derived = new Set<string>();
  const contacts: ContactInput[] = [];
  for (const p of people) {
    const domain = normDomain(p.company.domain);
    if (!domain.includes(".")) continue;
    const prior = accounts.get(domain);
    if (!prior || (derived.has(domain) && p.company.name)) {
      if (p.company.name) derived.delete(domain);
      else derived.add(domain);
      const c = p.company;
      accounts.set(domain, {
        domain,
        name: c.name ?? nameFromDomain(domain),
        ...(c.industry ? { industry: c.industry } : {}),
        ...(c.employees !== undefined ? { employees: c.employees } : {}),
        ...(c.country ? { country: c.country } : {}),
      });
    }
    if (!p.fullName.trim()) continue;
    contacts.push({
      accountDomain: domain,
      fullName: p.fullName.trim(),
      ...(p.title ? { title: p.title } : {}),
      ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}),
    });
  }
  return { accounts: [...accounts.values()], contacts, derivedNames: [...derived] };
}

/**
 * An upsert's idempotency key from its content: the record service answers a
 * repeated key with the first result without comparing payloads, so a key
 * must never be shared by two different batches.
 */
export function batchKey(jobId: string, kind: string, records: unknown[]): string {
  const text = JSON.stringify(records);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193) >>> 0;
    b = Math.imul(b ^ ch, 0x5bd1e995) >>> 0;
  }
  return `populate:${jobId}:${kind}:${records.length}:${a.toString(36)}${b.toString(36)}`;
}
