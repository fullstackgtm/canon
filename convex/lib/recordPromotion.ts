/**
 * The one way a record-service company or person is put on the ledger: Canon identity, linked by domain or email and
 * record id, and a stream that starts from the row (canonEntities.promoteRecords, anchorContacts, called only from here;
 * tests/recordSeeding.test.ts holds that). Callers name ids, never rows. `sees` (a caller's or agent's scoped client)
 * decides which records are promoted: one it doesn't return is not. The stream starts from the whole row, read with the
 * bare client: a scoped read leaves out the fields the reader's role hides, and a stream seeded from it would clear them.
 * Only the seed sees the whole row; nothing read here is returned.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clientFor, recordSnapshotOf } from "../records";
import { resubmitUnprocessed } from "./canon/partyLedger";
import type { RecordClient } from "./recordClient";
import type { ContactRow } from "./recordContract";

/** Accounts per promote call (each is one record-service read). */
export const PROMOTE_MAX = 50;

export type Anchored = { recordId: string; entityId: Id<"canonEntities"> };
export type Promoted = Anchored & { contacts: Anchored[] };
type ContactInput = { recordId: string; fullName: string; updatedAt?: number; email?: string; title?: string; linkedinUrl?: string };

const contactInputOf = (c: ContactRow): ContactInput => ({
  recordId: c.id, fullName: c.fullName, updatedAt: c.updatedAt,
  ...(c.email ? { email: c.email } : {}), ...(c.title ? { title: c.title } : {}), ...(c.linkedinUrl ? { linkedinUrl: c.linkedinUrl } : {}),
});

/** Promote the companies `sees` reads among `accountIds`, optionally with the people it reads. The others are `notFound`. */
export async function promoteAccounts(ctx: ActionCtx, sees: RecordClient, orgId: Id<"organizations">, accountIds: readonly string[], includeContacts = false): Promise<{ promoted: Promoted[]; notFound: string[] }> {
  const full = clientFor(ctx);
  const accounts = [];
  const notFound: string[] = [];
  for (const accountId of [...new Set(accountIds)]) {
    const seen = await sees.get(orgId, accountId);
    const detail = seen && await full.get(orgId, accountId);
    if (!seen || !detail) { notFound.push(accountId); continue; }
    const { id, domain, name, ...snapshot } = recordSnapshotOf(detail.account);
    const people = new Set(seen.contacts.map((c) => c.id));
    accounts.push({ recordId: id, domain, name, snapshot, contacts: includeContacts ? detail.contacts.filter((c) => people.has(c.id)).map(contactInputOf) : [] });
  }
  // One account (and its people) per transaction: each promoted record writes its stream. People the
  // transaction's facts-read budget did not reach go in the next one, with the account again (unchanged).
  const promoted: Promoted[] = [];
  for (const account of accounts) {
    const runs: Promoted[] = [];
    await resubmitUnprocessed<ContactInput>(account.contacts, async (contacts) => {
      const [{ unprocessed, ...run }] = await ctx.runMutation(internal.canonEntities.promoteRecords, { orgId, accounts: [{ ...account, contacts }] });
      runs.push(run);
      return unprocessed;
    });
    promoted.push({ ...runs[0]!, contacts: runs.flatMap((r) => r.contacts) });
  }
  return { promoted, notFound };
}

/** Anchor the people `sees` reads among `contactIds`, each with a stream that starts from their row. Returns their entities. */
export async function promoteContacts(ctx: ActionCtx, sees: RecordClient, orgId: Id<"organizations">, contactIds: readonly string[]): Promise<Anchored[]> {
  const full = clientFor(ctx);
  const contacts: ContactInput[] = [];
  for (const id of [...new Set(contactIds)].slice(0, PROMOTE_MAX)) {
    const row = (await sees.getContact(orgId, id)) && await full.getContact(orgId, id);
    if (row) contacts.push(contactInputOf(row));
  }
  // A few per transaction: each one starts a stream.
  const anchored: Anchored[] = [];
  for (let i = 0; i < contacts.length; i += 10) anchored.push(...await ctx.runMutation(internal.canonEntities.anchorContacts, { orgId, contacts: contacts.slice(i, i + 10) }));
  return anchored;
}
