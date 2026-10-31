/**
 * The record client every read a person or an agent makes goes through
 * (CP14): `base` with the visibility and field rules of one or more
 * principals on every read that returns records. A person's reads carry
 * their own access (records.callerClient). An agent run carries its
 * principals' (records.principalClient: its owner, and whoever started the
 * run), and reads only what every one of them sees.
 *
 * Lists, the register, search, reports and duplicates carry the scope into
 * the record service; a single company or person a principal does not see
 * reads as missing, and a company's people are those they see. A deal's
 * scope names the visible deals by id, from their Convex rows (`dealScope`).
 * Principals with full access get `base` unchanged. Writes are not scoped
 * here: each writer checks `may` and the row first.
 *
 * Pure: no Convex runtime, no Node-only imports.
 */
import { ConvexError } from "convex/values";
import {
  canSeeRecord, hasOwnerField, hiddenFields, intersectScopes, isRestricted, narrowsReads, ownerScope, refuseHiddenUse, scopeFor,
  type Access,
} from "./access.ts";
import { LIST_LIMIT_MAX, type ListRequest, type OwnerScope } from "./objects/listSpec.ts";
import type { AccountsFilter } from "./recordContract.ts";
import { atLeastVersion, type RecordClient } from "./recordClient.ts";

/** The contract whose legacy account and contact lists honour a visibility scope; an older service would ignore it. */
const SCOPE_CONTRACT = "1.29.0";

/**
 * The visibility scope of a register object for the legacy lists, or
 * undefined for every record: the records every principal sees. A restricted
 * read is refused when the record service is too old to apply it, so a scope
 * is never silently dropped.
 */
export async function legacyScope(client: RecordClient, accesses: readonly Access[], object: "account" | "contact") {
  const scope = accesses.map((a) => ownerScope(a, object, hasOwnerField(object))).reduce(intersectScopes, null);
  if (!scope) return undefined;
  if (client.mode === "http" && !atLeastVersion(await client.contractVersion(), SCOPE_CONTRACT)) {
    throw new ConvexError("Record visibility needs a newer record service; ask an admin to deploy it");
  }
  return { field: "ownerId" as const, owners: [...scope.owners], unowned: scope.unowned };
}

/**
 * Which of `ids` (record-service ids of companies or people) a client sees:
 * the live register rows among them, read through `client`. With a scoped
 * client (records.callerClient, records.principalClient) that is the records
 * every principal sees. A Convex surface keyed by a record id that a query
 * cannot judge (permissions.entitySight) admits the id here (CP14).
 */
export async function visibleIds(client: RecordClient, ws: string, object: "account" | "contact", ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const seen = new Set<string>();
  // A page returns at most LIST_LIMIT_MAX rows, so no chunk asks for more.
  for (let i = 0; i < unique.length; i += LIST_LIMIT_MAX) {
    const chunk = unique.slice(i, i + LIST_LIMIT_MAX);
    const page = await client.listRegister(ws, object, { filter: [{ field: "id", op: "in", value: chunk }], limit: chunk.length });
    for (const r of page.rows) seen.add(r.id);
  }
  return seen;
}

/**
 * Which of `values` (a company's domains, a person's emails; lowercased) name
 * a record `client` sees. With the bare client: which name any record.
 */
export async function visibleValues(client: RecordClient, ws: string, object: "account" | "contact", field: "domain" | "email", values: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(values.map((d) => d.toLowerCase()))].filter(Boolean);
  const seen = new Set<string>();
  for (let i = 0; i < unique.length; i += LIST_LIMIT_MAX) {
    const chunk = unique.slice(i, i + LIST_LIMIT_MAX);
    const page = await client.listRegister(ws, object, { filter: [{ field, op: "in", value: chunk }], limit: chunk.length });
    for (const r of page.rows) if (typeof r.values[field] === "string") seen.add((r.values[field] as string).toLowerCase());
  }
  return seen;
}

/** Which of `domains` name a company `client` sees (lowercased): signals and heat are keyed by a company's domain. */
export const visibleDomains = (client: RecordClient, ws: string, domains: readonly string[]) => visibleValues(client, ws, "account", "domain", domains);

/** A company or person a Convex query could not judge (permissions.ts sightJudge): its record-service id, or a company's domain. */
export type Pending = { object: "account" | "contact"; recordId: string } | { object: "account"; domain: string } | { object: "contact"; email: string };

/**
 * The action twin of a query a narrowed role cannot be judged by (CP14):
 * `read` once with nothing admitted; when it names companies or people only
 * the record service can judge, admit them through `client` (the caller's or
 * the agent's scoped client: visibleIds, visibleDomains) and read again with
 * them admitted.
 */
export async function admitThenRead<T>(client: RecordClient, ws: string, read: (admitted: string[]) => Promise<{ pending: readonly Pending[]; value: T }>): Promise<T> {
  const first = await read([]);
  if (!first.pending.length) return first.value;
  const ids = (object: "account" | "contact") => first.pending.flatMap((p) => ("recordId" in p && p.object === object ? [p.recordId] : []));
  const domains = first.pending.flatMap((p) => ("domain" in p ? [p.domain] : []));
  const emails = first.pending.flatMap((p) => ("email" in p ? [p.email] : []));
  const admitted = [
    ...await visibleIds(client, ws, "account", ids("account")), ...await visibleIds(client, ws, "contact", ids("contact")),
    ...(domains.length ? await visibleDomains(client, ws, domains) : []),
    ...(emails.length ? await visibleValues(client, ws, "contact", "email", emails) : []),
  ];
  return (await read(admitted)).value;
}

export function scopedRecordClient(base: RecordClient, accesses: readonly Access[], dealScope: () => Promise<OwnerScope | null>): RecordClient {
  if (!accesses.length) throw new ConvexError("A scoped read needs at least one principal");
  const matchInbound: RecordClient["matchInbound"] = async () => { throw new ConvexError("Inbound matching runs only as Canon."); };
  if (!accesses.some(isRestricted)) return { ...base, matchInbound };
  let dealIds: Promise<OwnerScope | null> | undefined;
  const scopeOf = (object: string): Promise<OwnerScope | null> => {
    if (object === "lineItem") return scopeOf("deal").then((parent) => {
      if (accesses.some((a) => !canSeeRecord(a, "lineItem", false, null))) return { field: "dealId", owners: [], unowned: false };
      return parent ? { ...parent, field: "dealId", unowned: false } : null;
    });
    if (object !== "deal") return Promise.resolve(accesses.map((a) => scopeFor(a, object)).reduce(intersectScopes, null));
    dealIds ??= accesses.some((a) => ownerScope(a, "deal", true)) ? dealScope() : Promise.resolve(null);
    return dealIds;
  };
  const scoped = async <T extends object>(object: string, req: T): Promise<T> => {
    const scope = await scopeOf(object);
    return scope ? { ...req, scope } : req;
  };
  const sees = (object: "account" | "contact", row: { ownerId?: string } | null | undefined) =>
    Boolean(row) && accesses.every((a) => canSeeRecord(a, object, true, row!.ownerId ?? null));
  const narrows = accesses.some(narrowsReads);
  const refuse = (object: string, fields: ReadonlyArray<string | undefined>) => { for (const a of accesses) refuseHiddenUse(a, object, fields); };
  // Field permissions (CP14): a field any principal may not see leaves every row, and no filter, sort, group or measure may name it.
  const hidden = (object: string) => new Set(accesses.flatMap((a) => hiddenFields(a, object)));
  const stripRow = <R extends { values: Record<string, unknown>; accountId?: string }>(object: string, row: R): R => {
    const h = hidden(object);
    if (!h.size) return row;
    const out = { ...row, ...(object === "lineItem" && h.has("name") ? { title: "" } : {}), values: Object.fromEntries(Object.entries(row.values).filter(([k]) => !h.has(k))) };
    if (object === "contact" && h.has("accountId")) delete out.accountId;
    return out;
  };
  /** A legacy row (column names are apiNames; custom fields live in `custom` by apiName). */
  const stripLegacy = <R extends object>(object: string, row: R): R => {
    const h = hidden(object);
    if (!h.size) return row;
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(row).filter(([k]) => !h.has(k) && !(k === "revenue" && h.has("annualRevenue"))));
    const custom = out.custom as Record<string, unknown> | undefined;
    if (custom && typeof custom === "object") out.custom = Object.fromEntries(Object.entries(custom).filter(([k]) => !h.has(k)));
    return out as R;
  };
  const stripHistory = <R extends { field: string }>(object: string, rows: R[]) => { const h = hidden(object); return rows.filter((r) => !h.has(r.field)); };
  /** The account fields a legacy filter or facet reads, as apiNames. */
  const legacyFields = (f: AccountsFilter | undefined, groupBy?: string) => [
    ...(f?.industry?.length ? ["industry"] : []), ...(f?.country?.length || f?.region?.length ? ["country"] : []),
    ...(f?.employeeMin !== undefined || f?.employeeMax !== undefined || f?.sizeBand?.length ? ["employees"] : []),
    ...(f?.status ? ["status"] : []), ...(f?.ownerId ? ["ownerId"] : []), ...(f?.q ? ["name", "domain"] : []),
    ...Object.keys(f?.custom ?? {}).map((slug) => `custom.${slug}`),
    ...(groupBy === "industry" ? ["industry"] : groupBy === "country" || groupBy === "region" ? ["country"] : groupBy === "sizeBand" ? ["employees"] : groupBy?.startsWith("field:") ? [`custom.${groupBy.slice(6)}`] : []),
  ];
  const listFields = (req: ListRequest) => [...(req.filter ?? []).map((f) => f.field), req.sort?.field];
  return {
    ...base,
    async list(ws, req) {
      refuse("account", [...legacyFields(req.filter), req.sort?.field === "employees" ? "employees" : req.sort?.field === "name" ? "name" : undefined]);
      const scope = await legacyScope(base, accesses, "account");
      const page = await base.list(ws, scope ? { ...req, filter: { ...req.filter, scope } } : req);
      return { ...page, rows: page.rows.map((r) => stripLegacy("account", r)) };
    },
    async listContacts(ws, req) {
      if (req.filter?.q) refuse("contact", ["title", "email"]);
      const scope = await legacyScope(base, accesses, "contact");
      const page = await base.listContacts(ws, scope ? { ...req, filter: { ...req.filter, scope } } : req);
      return { ...page, rows: page.rows.map((r) => stripLegacy("contact", r)) };
    },
    async countSegment(ws, filter) {
      refuse("account", legacyFields(filter));
      const scope = await legacyScope(base, accesses, "account");
      return base.countSegment(ws, scope ? { ...filter, scope } : filter);
    },
    async facets(ws, req) {
      refuse("account", legacyFields(req.filter, req.groupBy));
      const scope = await legacyScope(base, accesses, "account");
      return base.facets(ws, scope ? { ...req, filter: { ...req.filter, scope } } : req);
    },
    async get(ws, id) {
      const detail = await base.get(ws, id);
      if (!detail || !sees("account", detail.account)) return null;
      return {
        ...detail, account: stripLegacy("account", detail.account),
        contacts: detail.contacts.filter((c) => sees("contact", c)).map((c) => stripLegacy("contact", c)),
        history: stripHistory("account", detail.history),
      };
    },
    async getContact(ws, id) {
      const row = await base.getContact(ws, id);
      return row && sees("contact", row) ? stripLegacy("contact", row) : null;
    },
    async listRegister(ws, object, req) {
      refuse(object, listFields(req));
      const page = await base.listRegister(ws, object, await scoped(object, req));
      return { ...page, rows: page.rows.map((r) => stripRow(object, r)) };
    },
    async listObjects(ws, object, req) {
      refuse(object, listFields(req));
      const page = await base.listObjects(ws, object, await scoped(object, req));
      return { ...page, rows: page.rows.map((r) => stripRow(object, r)) };
    },
    async aggregate(ws, object, req) {
      // A key on a related record reads that record's fields, which this scope does not cover: not for a role with narrowed reads.
      if (narrows && req.groupBy?.some((g) => g.via !== undefined)) throw new ConvexError("Grouping by a related record's field isn't available for your role yet");
      refuse(object, [...(req.filter ?? []).map((f) => f.field), ...(req.groupBy ?? []).map((g) => g.field), ...req.measures.flatMap((m) => [m.field, m.weight])]);
      return base.aggregate(ws, object, await scoped(object, req));
    },
    async searchObjects(ws, req) {
      // Every object a rule narrows, by its scope; objects with no rule are seen whole.
      const scopes: Record<string, OwnerScope> = {};
      for (const object of new Set(["lineItem", ...accesses.flatMap((a) => Object.keys(a.rules))])) {
        const scope = await scopeOf(object);
        if (scope) scopes[object] = scope;
      }
      const found = await base.searchObjects(ws, Object.keys(scopes).length ? { ...req, scopes } : req);
      // A hit's detail (a company's domain, a person's email, a deal's amount) leaves out hidden fields; a hidden title field hides the hit.
      const titleField: Record<string, string[]> = { account: ["name", "domain"], contact: ["fullName", "email"], deal: ["name"], lineItem: ["name"] };
      const hits = found.hits
        .filter((h) => !(titleField[h.object] ?? []).some((f) => hidden(h.object).has(f)))
        .map((h) => (h.detail ? { ...h, detail: Object.fromEntries(Object.entries(h.detail).filter(([k]) => !hidden(h.object).has(k))) } : h));
      return { ...found, hits };
    },
    matchInbound,
    async listDuplicates(ws, object, limit) {
      const found = await base.listDuplicates(ws, object, limit, await legacyScope(base, accesses, object));
      // A member's detail is a company's industry or a person's title; the keys groups match on cannot be hidden (lib/access.ts unhideableFields).
      if (!hidden(object).has(object === "account" ? "industry" : "title")) return found;
      return { ...found, groups: found.groups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m, detail: null })) })) };
    },
    icpStats: async (ws) => (narrows ? { gates: [] } : base.icpStats(ws)),
    async icpTreeCounts(ws, req) {
      // Counts read companies' industry, country, size and AI answers, and people's titles: a role that hides one can't count by it.
      refuse("account", req.nodes.flatMap(({ account: x }) => [
        ...(x?.industries?.length || x?.excludeIndustries?.length ? ["industry"] : []), ...(x?.countries?.length || x?.excludeCountries?.length ? ["country"] : []),
        ...(x?.employees?.length ? ["employees"] : []), ...(x?.custom ?? []).map((c) => c.key),
      ]));
      if (req.nodes.some((n) => n.person || n.has?.length)) refuse("contact", ["title"]);
      const [accountScope, contactScope] = [await legacyScope(base, accesses, "account"), await legacyScope(base, accesses, "contact")];
      return base.icpTreeCounts(ws, { ...req, ...(accountScope ? { accountScope } : {}), ...(contactScope ? { contactScope } : {}) });
    },
    async territoryTreeCounts(ws, req) {
      // A territory counts the companies the caller sees, by fields their role shows: a hidden one can't carve, and owners
      // are named only to a role that sees the owner.
      refuse("account", [
        ...req.nodes.flatMap(({ account: x }) => [...(x?.industries?.length || x?.excludeIndustries?.length ? ["industry"] : []), ...(x?.countries?.length || x?.excludeCountries?.length ? ["country"] : []), ...(x?.employees?.length ? ["employees"] : [])]),
        ...(req.owners || req.cells || req.moves ? ["ownerId"] : []),
        ...(req.cells?.by ?? []).map((d) => (d === "sizeBand" ? "employees" : d === "region" ? "country" : d)),
      ]);
      const accountScope = await legacyScope(base, accesses, "account");
      return base.territoryTreeCounts(ws, { ...req, ...(accountScope ? { accountScope } : {}) });
    },
  };
}
