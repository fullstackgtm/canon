/**
 * A CRM sync's contact-to-company associations, sent to the register. The
 * sync writes contacts to the ledger, which carries no company (associations
 * are CP3), so their register rows would wait for one. The register links a
 * person to a company with contacts/upsert, found by email, as a CSV import
 * does; the company must exist first, so the sync's companies go in by domain
 * (fill-only), and the ledger's own write-back later attaches to those rows.
 * The CRM's association wins over the register's guess from the email domain.
 */
import type { RecordClient } from "./recordClient.ts";
import { batchKey } from "./peopleSources.ts";

const BATCH = 1000;

type CrmAccount = { crmId: string; domain?: string; name?: string };
type CrmContact = { email?: string; firstName?: string; lastName?: string; accountCrmId?: string };

/** The companies to make sure of and the people to link: only contacts with an email at a company with a domain. */
export function crmContactLinks(accounts: readonly CrmAccount[], contacts: readonly CrmContact[]) {
  const domainOf = new Map(accounts.flatMap((a) => (a.domain?.trim() ? [[a.crmId, { domain: a.domain.trim(), name: a.name?.trim() || a.domain.trim() }] as const] : [])));
  const links = contacts.flatMap((c) => {
    const account = c.accountCrmId ? domainOf.get(c.accountCrmId) : undefined;
    const email = c.email?.trim();
    if (!account || !email) return [];
    const fullName = [c.firstName, c.lastName].map((s) => s?.trim()).filter(Boolean).join(" ") || email;
    return [{ accountDomain: account.domain, email, fullName }];
  });
  const used = new Set(links.map((l) => l.accountDomain));
  return { accounts: [...domainOf.values()].filter((a) => used.has(a.domain)), links };
}

/**
 * Send them: companies first (fill-only), then the links to the companies the register took. `run` names
 * the sync run, so a retry within it replays and a later run applies a changed association again.
 */
export async function linkCrmContacts(client: Pick<RecordClient, "upsertAccounts" | "upsertContacts">, ws: string, source: string, run: string, links: ReturnType<typeof crmContactLinks>) {
  const refused = new Set<string>();
  for (let i = 0; i < links.accounts.length; i += BATCH) {
    const records = links.accounts.slice(i, i + BATCH);
    const out = await client.upsertAccounts(ws, { records, source, idempotencyKey: batchKey(`${source}:links:${run}`, "a", records), fill: "missing" });
    for (const r of out.rejected ?? []) refused.add(records[r.index].domain);
  }
  const wanted = links.links.filter((l) => !refused.has(l.accountDomain));
  let linked = 0;
  for (let i = 0; i < wanted.length; i += BATCH) {
    const records = wanted.slice(i, i + BATCH);
    const out = await client.upsertContacts(ws, { records, source, idempotencyKey: batchKey(`${source}:links:${run}`, "c", records) });
    linked += out.upserted;
  }
  return linked;
}
