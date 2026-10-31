/**
 * How accounts and contacts are identified in the Canon ledger. One entity per
 * company or person, however many stores hold a row for it: the TAM record in
 * the record service, a synced CRM row, or both. A record's own ids come first
 * (its CRM id, its record-service id), so a row seen before always resolves to
 * its own entity even when its email or domain went stale and now belongs to
 * someone else. The shared keys (domain, email) come last: a row seen for the
 * first time joins the entity of the same company or person.
 */
import type { ExternalId } from "./ledger.ts";

/** Same normalization as the record service (convex/lib/recordClient.ts normalizeDomain). */
export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
}

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** External-id providers. CRM ids are namespaced by object so a HubSpot company id never matches a deal id. */
export const ID = {
  domain: "domain",
  email: "email",
  recordAccount: "record:account",
  recordContact: "record:contact",
  crmAccount: (provider: string) => `${provider}:account`,
  crmContact: (provider: string) => `${provider}:contact`,
} as const;

export function accountExternalIds(a: { domain?: string | null; recordId?: string; crm?: { provider: string; crmId: string } }): ExternalId[] {
  const domain = a.domain ? normalizeDomain(a.domain) : "";
  return [
    ...(a.crm?.crmId ? [{ provider: ID.crmAccount(a.crm.provider), externalId: a.crm.crmId }] : []),
    ...(a.recordId ? [{ provider: ID.recordAccount, externalId: a.recordId }] : []),
    ...(domain ? [{ provider: ID.domain, externalId: domain }] : []),
  ];
}

/** `otherEmails`: a person's emails beside the primary (#299), tried after it: each one names the same person. */
export function contactExternalIds(c: { email?: string | null; otherEmails?: readonly string[] | null; recordId?: string; crm?: { provider: string; crmId: string } }): ExternalId[] {
  const emails = [...new Set([c.email, ...(c.otherEmails ?? [])].map((e) => (e ? normalizeEmail(e) : "")).filter((e) => e.includes("@")))];
  return [
    ...(c.crm?.crmId ? [{ provider: ID.crmContact(c.crm.provider), externalId: c.crm.crmId }] : []),
    ...(c.recordId ? [{ provider: ID.recordContact, externalId: c.recordId }] : []),
    ...emails.map((externalId) => ({ provider: ID.email, externalId })),
  ];
}

/**
 * The identity a unique field's value is (a contact's email, an account's
 * domain), or null. Such an identity follows the value's unique claim
 * (lib/objects/write.ts): the record that holds the value is the one it
 * resolves to, so a value one record gave up and another took never routes
 * to the first.
 */
export function uniqueValueIdentity(object: string, fieldId: string, value: unknown): ExternalId | null {
  const provider = uniqueIdentityProvider(object, fieldId);
  if (typeof value !== "string" || !provider) return null;
  const ids = provider === ID.email ? contactExternalIds({ email: value }) : accountExternalIds({ domain: value });
  return ids.find((x) => x.provider === provider) ?? null;
}

/**
 * The field whose claims a unique field's values share: a person's other emails are claimed as their
 * primary is (`unique:contact.email`), so one address belongs to one person, as primary or not.
 */
export function claimFieldOf(object: string, fieldId: string): string {
  return object === "contact" && fieldId === "additionalEmails" ? "email" : fieldId;
}

/** The identity provider a unique field's values are (see uniqueValueIdentity), or null. */
export function uniqueIdentityProvider(object: string, fieldId: string): string | null {
  if (object === "contact" && (fieldId === "email" || fieldId === "additionalEmails")) return ID.email;
  if (object === "account" && fieldId === "domain") return ID.domain;
  return null;
}
