/**
 * An audience's contacts: the register rows its filter matches plus the
 * contacts added to it one at a time (an event agent's route), each with the
 * employer's name and the custom fields written on its ledger stream. The
 * list pages carry each contact's fields, so only added contacts are read one
 * by one.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { ListRequest, RegisterListResponse, RegisterListRow } from "../objects/listSpec.ts";
import type { ContactRow } from "../recordContract.ts";
import { AUDIENCE_MAX, variableName, type OutboundContact } from "./audience.ts";

export type CustomValues = Record<string, string | number | boolean>;

export type ResolvePorts = {
  listContacts(req: ListRequest): Promise<RegisterListResponse>;
  getContact(id: string): Promise<ContactRow | null>;
  accountNames(accountIds: string[]): Promise<Record<string, string>>;
  /** Custom (non-standard) field values of worked contacts, by stream id, keyed by field apiName. */
  customValues(streamIds: string[]): Promise<Record<string, CustomValues>>;
};

export type Resolved = { contacts: OutboundContact[]; total: number; tooLarge: boolean };

const FETCH_PARALLEL = 10;
const PAGE = 200;
/** Streams one custom-values read folds; the ports are called once per chunk. */
const CUSTOM_CHUNK = 100;

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A list row as the contact the rest of this module reads. A row without `accountId` (service before 1.12.0) is read in full instead. */
function contactOfRow(r: RegisterListRow): ContactRow | null {
  if (r.accountId === undefined) return null;
  return {
    id: r.id, accountId: r.accountId, fullName: r.title, status: "", updatedAt: r.updatedAt,
    title: text(r.values.title), email: text(r.values.email), phone: text(r.values.phone), linkedinUrl: text(r.values.linkedinUrl),
    ...(r.stream ? { stream: r.stream } : {}),
    ...listsOf(r),
  };
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
/** A person's other emails and phones (#299), when the row has any. */
function listsOf(r: RegisterListRow): { otherEmails?: string[]; otherPhones?: string[] } {
  const [e, p] = [strings(r.values.additionalEmails), strings(r.values.additionalPhones)];
  return { ...(e.length ? { otherEmails: e } : {}), ...(p.length ? { otherPhones: p } : {}) };
}

export async function resolveContacts(ports: ResolvePorts, filter: ListRequest["filter"], addedIds: readonly string[] = []): Promise<Resolved> {
  const first = await ports.listContacts({ filter, limit: PAGE });
  // The filter alone already over the cap: nothing to fetch. Otherwise the cap is on distinct members, below.
  if (first.total > AUDIENCE_MAX) return { contacts: [], total: first.total, tooLarge: true };
  const rows = [...first.rows];
  for (let cursor = first.nextCursor; cursor; ) {
    const page = await ports.listContacts({ filter, limit: PAGE, cursor });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  }
  const byId = new Map<string, ContactRow | null>();
  for (const r of rows) byId.set(r.id, contactOfRow(r));
  for (const id of addedIds) if (!byId.has(id)) byId.set(id, null);
  if (byId.size > AUDIENCE_MAX) return { contacts: [], total: byId.size, tooLarge: true };
  // Contacts added one at a time, and rows from an older service: read each.
  const missing = [...byId].flatMap(([id, c]) => (c ? [] : [id]));
  for (let i = 0; i < missing.length; i += FETCH_PARALLEL) {
    const got = await Promise.all(missing.slice(i, i + FETCH_PARALLEL).map((id) => ports.getContact(id)));
    got.forEach((c, j) => byId.set(missing[i + j], c));
  }
  const records = [...byId.values()].flatMap((c) => (c ? [c] : []));
  const streams = records.flatMap((c) => (c.stream ? [c.stream] : []));
  const custom: Record<string, CustomValues> = {};
  for (let i = 0; i < streams.length; i += CUSTOM_CHUNK) Object.assign(custom, await ports.customValues(streams.slice(i, i + CUSTOM_CHUNK)));
  const names = await ports.accountNames(records.map((c) => c.accountId));
  const contacts = records.map((c): OutboundContact => ({
    id: c.id,
    email: c.email ?? null,
    fullName: c.fullName,
    title: c.title ?? null,
    company: names[c.accountId] ?? null,
    phone: c.phone ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    ...("otherEmails" in c && Array.isArray(c.otherEmails) ? { otherEmails: c.otherEmails as string[] } : {}),
    ...("otherPhones" in c && Array.isArray(c.otherPhones) ? { otherPhones: c.otherPhones as string[] } : {}),
    custom: Object.fromEntries(Object.entries((c.stream && custom[c.stream]) || {}).map(([k, v]) => [variableName(k), v])),
  }));
  return { contacts, total: contacts.length, tooLarge: false };
}
