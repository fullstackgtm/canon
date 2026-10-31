/**
 * Record-service client (WS1 consumer).
 *
 * - When `RECORD_SERVICE_URL` is set, every call goes over HTTP to the WS1
 *   record service (`Authorization: Bearer RECORD_SERVICE_TOKEN`,
 *   `X-Workspace-Id: <orgId>`).
 * - When it is unset, a fake is used. The fake implements the same semantics
 *   (filter, sort, cursor paging, edit versioning, field history) over a
 *   pluggable `FakeRecordStore`: an in-memory store for tests, and a
 *   Convex-table-backed store (see convex/records.ts) so dev edits persist.
 *   Its shared prospect index is the synthetic PDL fixture generated below.
 *
 * Pure module: no Convex or Node imports, so tests import it directly.
 */
import { matchInbound, type InboundMatch, type InboundMatchInput } from "./objects/inboundMatch.ts";
import type {
  AccountInput,
  AccountRow,
  AccountsFilter,
  AccountsListRequest,
  AccountsListResponse,
  AccountStatus,
  ContactInput,
  ContactRow,
  ContactsListRequest,
  ContactsListResponse,
  EditRequest,
  EditResponse,
  FieldHistoryRow,
  GetContactResponse,
  GetResponse,
  IcpGate,
  IcpStats,
  IcpTreeCounts,
  IcpTreeCountsRequest,
  MarketDimension,
  MarketFacetsResponse,
  MarketFilter,
  IcpWeights,
  SharedSearchResponse,
  SharedCompanyDetail,
  UpsertAccountsRequest,
  UpsertContactsRequest,
  UpsertResponse,
} from "./recordContract.ts";
import { EDITABLE_ACCOUNT_FIELDS, EDITABLE_CONTACT_FIELDS, editRequestKey, reusedEditKeyMessage } from "./recordContract.ts";
import type { AnnotateRecord, AnnotateResponse, FacetDimension, FacetGroup, FacetsRequest, FacetsResponse } from "./recordContract.ts";
import { NONE, regionOf, sizeBandOf } from "../../services/record-service/src/dimensions.ts";
import { industryFilterKeys, industryKey, industryWeight } from "../../services/record-service/src/industries.ts";
import { indexObjectDef, resolveObjectDef, STANDARD_OBJECTS, type ObjectDef } from "./objects/registry.ts";
import {
  compileSearch, IN_VALUES_MAX, isRegisterObject, LIST_LIMIT_MAX, listRowsInMemory, ListRequestError, ownerAdmitted, rankSearchHits, registerListDef, searchAdmits, registerListRow, searchRowsInMemory,
  type ListRequest, type ListResponse, type ListRow, type ProjectedThrough, type RegisterListResponse, type RegisterObject, type SearchRequest, type SearchResponse,
} from "./objects/listSpec.ts";
import { SHARDS } from "./objects/write.ts";
import { countIcpTree, gatedFit } from "./icpGates.ts";
import { countTerritoryTree, passes, territoryTreeProblem, type TerritoryAccountRow, type TerritoryTreeBody, type TerritoryTreeResult } from "../../services/record-service/src/territoryTree.ts";
/** A territory tree to count, scoped as an ICP tree is (1.29.0 owner scope). */
export type TerritoryTreeRequest = TerritoryTreeBody & { accountScope?: { field: "ownerId"; owners: string[]; unowned: boolean } };
export type { TerritoryTreeResult };
import { sameProjection, type ActivityAggregateReceipt, type ActivityAggregateRequest, type ModuleAggregateRequest, type ModuleProjection, type ModuleSyncRequest, type ModuleSyncResponse } from "./objects/moduleReport.ts";
import { canonicalJson } from "../../modules/kernel/integrity.ts";
import { ACTIVITY_OBJECT, ACTIVITY_TYPES, activityReportDef, aggregateRowsInMemory, compileAggregateRequest, type AggregateResponse } from "./objects/reportSpec.ts";
import { findDuplicates, type DuplicateGroup, type DuplicateObject } from "./objects/duplicates.ts";

export type RecordClient = {
  mode: "http" | "fake";
  /** The service's contract version ("1.5.0"), or null when it can't be read. The fake implements the latest. */
  contractVersion(): Promise<string | null>;
  prepareResearch(body: { sessionId: string; expiresAt: number; records: AccountInput[]; source: string }): Promise<{ total: number }>;
  commitResearch(ws: string, sessionId: string): Promise<{ importedAccounts: number; total: number; done: boolean }>;
  provision(ws: string): Promise<{ created: boolean }>;
  list(ws: string, req: AccountsListRequest): Promise<AccountsListResponse>;
  listContacts(ws: string, req: ContactsListRequest): Promise<ContactsListResponse>;
  get(ws: string, id: string): Promise<GetResponse | null>;
  getContact(ws: string, id: string): Promise<ContactRow | null>;
  upsertAccounts(ws: string, body: UpsertAccountsRequest): Promise<UpsertResponse>;
  upsertContacts(ws: string, body: UpsertContactsRequest): Promise<UpsertResponse>;
  edit(ws: string, body: EditRequest): Promise<EditResponse>;
  countSegment(ws: string, filter: AccountsFilter): Promise<{ total: number }>;
  /** Group the workspace's accounts by one TAM dimension (service 1.4.0). */
  facets(ws: string, req: FacetsRequest): Promise<FacetsResponse>;
  /** Write derived revenue and traits (service 1.4.0). Batches of up to 2000. */
  annotate(ws: string, records: AnnotateRecord[]): Promise<AnnotateResponse>;
  /** `rank` sorts the whole match set by ICP fit before limiting; rows then carry fit (0..1). */
  searchShared(filter: AccountsFilter, limit: number, rank?: IcpWeights): Promise<SharedSearchResponse>;
  /** The shared index's row for each domain it has, up to 1000 domains per call (service 1.46.0). */
  lookupShared(domains: string[]): Promise<SharedCompanyDetail[]>;
  /** The shared index grouped by one dimension: how many companies exist per tile (service 1.19.0). */
  marketFacets(filter: MarketFilter, groupBy: MarketDimension, limit?: number): Promise<MarketFacetsResponse>;
  /** Store the workspace ICP and recompute every account's fit. */
  /** Score with a snapshot's version. Service 1.41.0 rejects older or unversioned sends after a numbered one; equal versions are idempotent. Gates set fit and icpIds. */
  rescore(ws: string, icp: IcpWeights, version?: number, gates?: IcpGate[]): Promise<{ rescored: number }>;
  /** Per saved ICP gate: its members, and the accounts it can't decide for unknown values (service 1.14.0). */
  icpStats(ws: string): Promise<IcpStats>;
  /** Counts for ICPs as trees (service 1.31.0): each node's accounts and people, and the accounts sibling nodes share. */
  icpTreeCounts(ws: string, req: IcpTreeCountsRequest): Promise<IcpTreeCounts>;
  /** Service 1.37.0: a territory tree's counts (services/record-service/src/territoryTree.ts). */
  territoryTreeCounts(ws: string, req: TerritoryTreeRequest): Promise<TerritoryTreeResult>;
  /** A list view of one ledger object (CP1f): filter, sort and keyset paging over the projector's `p_<object>` table. Throws ListRequestError on a request it cannot serve. */
  listObjects(ws: string, object: string, req: ListRequest): Promise<ListResponse>;
  /** Title search across ledger objects. */
  searchObjects(ws: string, req: SearchRequest): Promise<SearchResponse>;
  /** The same list request over the register (service 1.9.0): every account or contact, worked or not, by its record-service id. */
  listRegister(ws: string, object: RegisterObject, req: ListRequest): Promise<RegisterListResponse>;
  /** A report over one object's live records (service 1.27.0): the list's filters, up to two group keys, up to four measures. Throws ListRequestError on a request it cannot serve. */
  aggregate(ws: string, object: string, req: ActivityAggregateRequest): Promise<AggregateResponse>;
  /** Module reports (1.33.0): a module's changed docs. The fake keeps none: its reports read the docs in Convex. */
  moduleSync(ws: string, body: ModuleSyncRequest): Promise<ModuleSyncResponse>;
  /** A report over one module collection's docs, as the request's scope admits them (convex/lib/modules/reports.ts). */
  moduleAggregate(ws: string, body: ModuleAggregateRequest): Promise<AggregateResponse>;
  /** IDs and reasons from the workspace register, for system module calls only. */
  matchInbound(ws: string, input: InboundMatchInput): Promise<InboundMatch>;
  /** Candidate duplicate groups over the live register, strongest first (service 1.24.0). `total` counts every group, `groups` the first `limit`. */
  /** `scope` (1.29.0): candidates among the records a caller sees only. */
  listDuplicates(ws: string, object: RegisterObject, limit: number, scope?: { field: "ownerId"; owners: string[]; unowned: boolean }): Promise<{ groups: DuplicateGroup[]; total: number }>;
  /** Tell the projector the org's ledger moved to these shard heads. The fake has no projector. */
  /** `source` is this deployment's HTTP site, where the service pulls the ledger from. */
  /** `wait`: return once the projector has applied the ledger up to `heads` (a records.edit waiting for its write-back). */
  nudgeProjector(ws: string, heads: Record<string, number>, source?: string, opts?: { wait?: boolean }): Promise<void>;
};

/**
 * What the fake lists ledger objects from: the org's records as list rows,
 * the objects' definitions, and the shard heads the rows reflect. Convex
 * passes one over hot rows (convex/objects.ts).
 */
export interface FakeObjectSource {
  rows(ws: string, objects: readonly string[] | null): Promise<{ rows: ListRow[]; defs: ObjectDef[]; heads: Record<string, number> }>;
}

const throughAll = (heads: Record<string, number>): ProjectedThrough =>
  Object.fromEntries(Array.from({ length: SHARDS }, (_, s) => [String(s), heads[String(s)] ?? 0]));

/**
 * Fit (0..1) of an account under ICP weights; the same model as the record
 * service (services/record-service ops.ts FIT_FROM and pdl.ts fitSql), used by
 * the fake client so dev and tests rank identically.
 */
export function fitUnderWeights(row: { industry?: string; country?: string; employees?: number }, w: IcpWeights): number {
  let pts = w.base ?? 0;
  const ctry = (row.country ?? "").toLowerCase();
  pts += industryWeight(w.industries, row.industry) ?? 0;
  for (const [k, v] of Object.entries(w.countries ?? {})) if (k.toLowerCase() === ctry) pts += v;
  if (row.employees !== undefined) for (const b of w.employeeBands ?? []) if (row.employees >= b.min && row.employees <= b.max) pts += b.weight;
  return Math.min(100, Math.max(0, pts)) / 100;
}

// ───────────────────────────── Pure list helpers ─────────────────────────────

const lower = (value: string | undefined) => (value ?? "").toLowerCase();

/** Case-insensitive membership where "__none__" matches a missing value (service whereFor). */
function inWithNone(value: string | undefined, wanted: string[]): boolean {
  if (!value) return wanted.includes(NONE);
  const v = value.toLowerCase();
  return wanted.some((w) => w !== NONE && w.toLowerCase() === v);
}

/** The value an account groups under for a facet dimension (several for `segment`). */
export function facetKeys(row: Partial<AccountRow>, dim: FacetDimension): string[] {
  switch (dim) {
    case "industry": return [row.industry?.trim() ? industryKey(row.industry) : NONE];
    case "country": return [row.country ? row.country.toLowerCase() : NONE];
    case "sizeBand": return [sizeBandOf(row.employees)];
    case "region": return [regionOf(row.country)];
    case "segment": return row.segmentIds?.length ? row.segmentIds : [NONE];
    // The fake keeps no AI-field answers on rows: every account is "not answered".
    default: return dim.startsWith("field:") ? [NONE] : [row.traits?.[dim.slice("trait:".length)] ?? NONE];
  }
}

export function facetRows(rows: Partial<AccountRow>[], req: FacetsRequest): FacetsResponse {
  const groups = new Map<string, FacetGroup>();
  let revenue = 0;
  let revenueKnown = 0;
  let employees = 0;
  for (const row of rows) {
    const known = typeof row.revenue === "number";
    const emp = row.employees ?? 0;
    if (known) (revenue += row.revenue!, revenueKnown++);
    employees += emp;
    for (const key of facetKeys(row, req.groupBy)) {
      const g = groups.get(key) ?? { key, count: 0, revenue: 0, revenueKnown: 0, employees: 0 };
      g.count++;
      g.employees += emp;
      if (known) (g.revenue += row.revenue!, g.revenueKnown++);
      groups.set(key, g);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  const limit = req.limit ?? 200;
  return { groups: sorted.slice(0, limit), total: rows.length, revenue, revenueKnown, employees, truncated: sorted.length > limit };
}

/** Apply annotations to a row (service ops.annotate semantics). */
export function annotateRow(row: AccountRow, rec: AnnotateRecord): AccountRow {
  const next: AccountRow = { ...row };
  const keepCrm = rec.revenueSource === "estimate" && row.revenueSource === "crm";
  if (rec.revenue !== undefined && !keepCrm) {
    if (rec.revenue === null) {
      delete next.revenue; delete next.revenueSource; delete next.revenueConfidence;
    } else {
      next.revenue = rec.revenue;
      next.revenueSource = rec.revenueSource ?? "crm";
      if (rec.revenueConfidence === undefined) delete next.revenueConfidence;
      else next.revenueConfidence = rec.revenueConfidence;
    }
  }
  if (rec.traits) {
    const traits = { ...(row.traits ?? {}) };
    for (const [k, v] of Object.entries(rec.traits)) {
      if (v === null) delete traits[k];
      else traits[k] = v;
    }
    next.traits = traits;
  }
  return next;
}

export function matchesFilter(row: AccountRow | (AccountInput & { fit?: number }), filter: AccountsFilter | undefined): boolean {
  if (!filter) return true;
  const r = row as Partial<AccountRow>;
  if (filter.segmentId === NONE) {
    if ((r.segmentIds ?? []).length) return false;
  } else if (filter.segmentId && !(r.segmentIds ?? []).includes(filter.segmentId)) return false;
  if (filter.status && (r.status ?? "new") !== filter.status) return false;
  if (filter.ownerId && r.ownerId !== filter.ownerId) return false;
  if (filter.scope && !ownerAdmitted(filter.scope, r.ownerId)) return false;
  if (filter.minFit !== undefined && (r.fit ?? 0) < filter.minFit) return false;
  if (filter.q) {
    const q = filter.q.toLowerCase();
    if (!lower(row.name).includes(q) && !lower(row.domain).includes(q)) return false;
  }
  if (filter.industry?.length) {
    const keys = industryFilterKeys(filter.industry);
    if (!keys.includes(row.industry?.trim() ? industryKey(row.industry) : NONE)) return false;
  }
  if (filter.country?.length && !inWithNone(row.country, filter.country)) return false;
  if (filter.sizeBand?.length && !filter.sizeBand.includes(sizeBandOf(row.employees))) return false;
  if (filter.region?.length && !filter.region.includes(regionOf(row.country))) return false;
  for (const [key, values] of Object.entries(filter.traits ?? {})) {
    if (!values.includes(r.traits?.[key] ?? NONE)) return false;
  }
  if (filter.employeeMin !== undefined && (row.employees ?? 0) < filter.employeeMin) return false;
  if (filter.icpId && !(r.icpIds ?? []).includes(filter.icpId)) return false;
  for (const values of Object.values(filter.custom ?? {})) if (!values.includes(NONE)) return false;
  if (filter.employeeMax !== undefined && (row.employees ?? Number.MAX_SAFE_INTEGER) > filter.employeeMax) return false;
  if (filter.criteria?.some((c) => !passes(r as TerritoryAccountRow, c))) return false;
  return true;
}

export function sortAccounts(rows: AccountRow[], sort: AccountsListRequest["sort"]): AccountRow[] {
  const { field, dir } = sort ?? { field: "fit" as const, dir: "desc" as const };
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (field === "name") cmp = a.name.localeCompare(b.name);
    else cmp = ((a[field] ?? 0) as number) - ((b[field] ?? 0) as number);
    if (cmp === 0) cmp = a.id.localeCompare(b.id) * sign; // stable tie-break so cursors are deterministic
    return cmp * sign;
  });
}

export function encodeCursor(offset: number): string {
  return `o${offset.toString(36)}`;
}
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = parseInt(cursor.slice(1), 36);
  return cursor.startsWith("o") && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function pageOf<T>(rows: T[], cursor: string | undefined, limit: number | undefined) {
  const size = Math.min(Math.max(limit ?? 50, 1), 200);
  const offset = decodeCursor(cursor);
  const slice = rows.slice(offset, offset + size);
  const next = offset + size < rows.length ? encodeCursor(offset + size) : null;
  return { rows: slice, nextCursor: next, total: rows.length };
}

const ACCOUNT_STATUSES: AccountStatus[] = ["new", "working", "qualified", "disqualified"];

/**
 * Validate and apply a user patch. Returns the new row plus one history entry
 * per changed field. Unknown/uneditable fields throw so the UI can't write
 * arbitrary keys.
 */
export function applyPatch<T extends Record<string, unknown> & { version?: number }>(
  object: "account" | "contact",
  id: string,
  row: T,
  patch: Record<string, string | number | null>,
  actorId: string,
  now: number,
): { row: T; history: FieldHistoryRow[]; version: number } {
  const allowed: readonly string[] = object === "account" ? EDITABLE_ACCOUNT_FIELDS : EDITABLE_CONTACT_FIELDS;
  const next: Record<string, unknown> = { ...row };
  const history: FieldHistoryRow[] = [];
  const version = (row.version ?? 0) + 1;
  for (const [field, raw] of Object.entries(patch)) {
    if (!allowed.includes(field)) throw new Error(`records.edit: field "${field}" is not editable on ${object}`);
    let value: string | number | null = raw;
    if (field === "employees" && value !== null) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error("records.edit: employees must be a non-negative number");
      value = Math.round(n);
    }
    if (field === "status" && object === "account" && !ACCOUNT_STATUSES.includes(value as AccountStatus)) {
      throw new Error(`records.edit: status must be one of ${ACCOUNT_STATUSES.join(", ")}`);
    }
    if (typeof value === "string") value = value.trim();
    if (field === "name" || field === "fullName") {
      if (!value) throw new Error(`records.edit: ${field} cannot be empty`);
    }
    const old = (row[field] ?? null) as string | number | null;
    const normalized = value === "" ? null : value;
    if (old === normalized) continue;
    if (normalized === null) delete next[field];
    else next[field] = normalized;
    history.push({ object, id, field, oldValue: old, newValue: normalized, actorId, at: now, version });
  }
  if (history.length === 0) return { row, history, version: row.version ?? 0 };
  next.updatedAt = now;
  next.version = version;
  return { row: next as T, history, version };
}

/** Service upsert normalization (services/record-service/src/upsert.ts normDomain). */
export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
}

export function accountIdFor(domain: string): string {
  return `acc_${domain.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}
export function contactIdFor(accountId: string, fullName: string, email?: string): string {
  const key = `${accountId}:${(email ?? fullName).toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `con_${(h >>> 0).toString(36)}`;
}

/** Upsert merge: incoming firmographics fill/refresh, but user-owned triage (status, owner) survives re-imports. */
export function mergeAccount(existing: AccountRow | null, input: AccountInput, source: string, now: number, fill?: "all" | "missing"): AccountRow {
  const id = existing?.id ?? accountIdFor(input.domain);
  return {
    id,
    domain: input.domain.toLowerCase(),
    // The fake fills only missing values unless the caller asks to overwrite (fill: "all");
    // a guarded name replaces only the placeholder it names.
    name: !existing ? input.name
      : input.nameIfCurrently !== undefined ? (existing.name === input.nameIfCurrently ? input.name : existing.name)
      : fill === "all" ? input.name : existing.name,
    industry: existing?.industry ?? input.industry,
    employees: existing?.employees ?? input.employees,
    country: existing?.country ?? input.country,
    linkedinUrl: existing?.linkedinUrl ?? input.linkedinUrl,
    fit: input.fit ?? existing?.fit ?? 0,
    status: existing?.status ?? input.status ?? "new",
    ownerId: existing?.ownerId ?? input.ownerId,
    segmentIds: [...new Set([...(existing?.segmentIds ?? []), ...(input.segmentIds ?? [])])],
    source: existing?.source ?? source,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    // Derived data (annotate) survives re-imports, as in the service.
    ...(existing?.revenue !== undefined ? { revenue: existing.revenue, revenueSource: existing.revenueSource, revenueConfidence: existing.revenueConfidence } : {}),
    ...(existing?.traits ? { traits: existing.traits } : {}),
  };
}

// ───────────────────────────── Fake store ─────────────────────────────

export function scoreFakeAccounts(rows: AccountRow[], contacts: ContactRow[], icp: IcpWeights, gates: IcpGate[]): AccountRow[] {
  const titles = new Map<string, string[]>();
  for (const c of contacts) if (c.accountId && c.title) titles.set(c.accountId, [...(titles.get(c.accountId) ?? []), c.title]);
  return rows.map((row) => {
    const result = gates.length ? gatedFit({ ...row, titles: titles.get(row.id) ?? [] }, gates) : { fit: fitUnderWeights(row, icp), icpIds: [] };
    return "unknown" in result ? row : { ...row, fit: result.fit, icpIds: result.icpIds };
  });
}

export interface FakeRecordStore {
  provision(ws: string): Promise<boolean>;
  allAccounts(ws: string): Promise<AccountRow[]>;
  getAccount(ws: string, id: string): Promise<AccountRow | null>;
  getAccountsByIds(ws: string, ids: string[]): Promise<Map<string, AccountRow>>;
  allContacts(ws: string): Promise<ContactRow[]>;
  getContact(ws: string, id: string): Promise<ContactRow | null>;
  contactsFor(ws: string, accountId: string): Promise<ContactRow[]>;
  history(ws: string, id: string): Promise<FieldHistoryRow[]>;
  putAccounts(ws: string, rows: AccountRow[]): Promise<void>;
  putContacts(ws: string, rows: ContactRow[]): Promise<void>;
  rescore(ws: string, icp: IcpWeights, version?: number, gates?: IcpGate[]): Promise<{ rescored: number; gates: IcpGate[] }>;
  /**
   * Apply a user edit atomically (read-modify-write + history append), with
   * `at` from the workspace's commit clock as the record service does. A
   * replayed idempotency key returns its first response and applies nothing;
   * a key reused for a different edit throws.
   */
  edit(ws: string, req: EditRequest, now: number): Promise<EditResponse>;
  /** Idempotency: returns the earlier response for a key, or records a new one. */
  seenKey(ws: string, key: string): Promise<UpsertResponse | null>;
  rememberKey(ws: string, key: string, response: UpsertResponse): Promise<void>;
}

export function createMemoryRecordStore(): FakeRecordStore {
  const workspaces = new Map<string, {
    accounts: Map<string, AccountRow>;
    contacts: Map<string, ContactRow>;
    history: FieldHistoryRow[];
    keys: Map<string, UpsertResponse>;
    edits: Map<string, { response: EditResponse; request: string }>;
    lastAt: number;
    icpVersion?: number;
    icpGates?: IcpGate[];
  }>();
  const wsOf = (ws: string) => {
    let state = workspaces.get(ws);
    if (!state) {
      state = { accounts: new Map(), contacts: new Map(), history: [], keys: new Map(), edits: new Map(), lastAt: 0 };
      workspaces.set(ws, state);
    }
    return state;
  };
  return {
    async rescore(ws, icp, version, gates = []) {
      const state = wsOf(ws);
      if (state.icpVersion !== undefined) {
        if (version === undefined || version < state.icpVersion) throw new Error("stale ICP version");
        if (version === state.icpVersion) return { rescored: 0, gates: state.icpGates ?? [] };
      }
      const rows = scoreFakeAccounts([...state.accounts.values()], [...state.contacts.values()], icp, gates);
      for (const row of rows) state.accounts.set(row.id, row);
      state.icpVersion = version;
      state.icpGates = gates;
      return { rescored: rows.length, gates };
    },
    async provision(ws) {
      const created = !workspaces.has(ws);
      wsOf(ws);
      return created;
    },
    async allAccounts(ws) { return [...wsOf(ws).accounts.values()]; },
    async getAccount(ws, id) { return wsOf(ws).accounts.get(id) ?? null; },
    async getAccountsByIds(ws, ids) {
      const out = new Map<string, AccountRow>();
      for (const id of ids) { const row = wsOf(ws).accounts.get(id); if (row) out.set(id, row); }
      return out;
    },
    async allContacts(ws) { return [...wsOf(ws).contacts.values()]; },
    async getContact(ws, id) { return wsOf(ws).contacts.get(id) ?? null; },
    async contactsFor(ws, accountId) { return [...wsOf(ws).contacts.values()].filter((c) => c.accountId === accountId); },
    async history(ws, id) { return wsOf(ws).history.filter((h) => h.id === id).sort((a, b) => b.at - a.at || b.version - a.version); },
    async putAccounts(ws, rows) { for (const row of rows) wsOf(ws).accounts.set(row.id, row); },
    async putContacts(ws, rows) { for (const row of rows) wsOf(ws).contacts.set(row.id, row); },
    async edit(ws, req, now) {
      const state = wsOf(ws);
      const request = editRequestKey(req);
      const seen = state.edits.get(req.idempotencyKey);
      if (seen && seen.request !== request) throw new Error(`records.edit: ${reusedEditKeyMessage(req.idempotencyKey)}`);
      if (seen) return seen.response;
      let version: number;
      if (req.object === "account") {
        const row = state.accounts.get(req.id);
        if (!row) throw new Error(`records.edit: account ${req.id} not found`);
        const result = applyPatch("account", req.id, row as AccountRow & Record<string, unknown>, req.patch, req.actorId, now);
        state.accounts.set(req.id, result.row);
        state.history.push(...result.history);
        version = result.version;
      } else {
        const row = state.contacts.get(req.id);
        if (!row) throw new Error(`records.edit: contact ${req.id} not found`);
        const result = applyPatch("contact", req.id, row as ContactRow & Record<string, unknown>, req.patch, req.actorId, now);
        state.contacts.set(req.id, result.row);
        state.history.push(...result.history);
        version = result.version;
      }
      state.lastAt = Math.max(now, state.lastAt + 1);
      const response = { version, at: state.lastAt };
      state.edits.set(req.idempotencyKey, { response, request });
      return response;
    },
    async seenKey(ws, key) { return wsOf(ws).keys.get(key) ?? null; },
    async rememberKey(ws, key, response) { wsOf(ws).keys.set(key, response); },
  };
}

export function createFakeRecordClient(opts: {
  store: FakeRecordStore;
  objects?: FakeObjectSource;
  shared?: () => AccountInput[];
  now?: () => number;
}): RecordClient {
  const { store, objects } = opts;
  const now = opts.now ?? (() => Date.now());
  const shared = opts.shared ?? (() => pdlSampleAccounts());
  const gatesByWs = new Map<string, IcpGate[]>();
  /** The register's rows of `object` as list rows of `def`, a registerListDef. */
  async function registerRows(ws: string, object: RegisterObject, def: ReturnType<typeof registerListDef>) {
    // The fake keeps fit as the app reads it (0..1); the register lists the service's 0-100.
    return object === "account"
      ? (await store.allAccounts(ws)).map((row) => registerListRow(object, def, { ...row, fit: row.fit * 100 }))
      : await (async () => {
        // A contact carries its account's fit and ICPs (1.15.0): its account's, else (as the service links it, 1.16.0) its email's domain's.
        const all = await store.allAccounts(ws);
        const accounts = new Map(all.map((a) => [a.id, a]));
        const byDomain = new Map(all.filter((a) => a.domain).map((a) => [a.domain.toLowerCase(), a]));
        return (await store.allContacts(ws)).map((row) => {
          const account = row.accountId ? accounts.get(row.accountId) : byDomain.get((row.email ?? "").split("@")[1]?.toLowerCase() ?? "");
          return registerListRow(object, def, { ...row, accountFit: account ? account.fit * 100 : null, accountIcpIds: account?.icpIds ?? [] });
        });
      })();
  }
  return {
    mode: "fake",
    async prepareResearch() { throw new Error("Research staging requires the record service"); },
    async commitResearch() { throw new Error("Research staging requires the record service"); },
    contractVersion: async () => FAKE_CONTRACT_VERSION,
    async provision(ws) { return { created: await store.provision(ws) }; },
    async list(ws, req) {
      const rows = (await store.allAccounts(ws)).filter((row) => matchesFilter(row, req.filter));
      return pageOf(sortAccounts(rows, req.sort), req.cursor, req.limit);
    },
    async listContacts(ws, req) {
      const q = req.filter?.q?.toLowerCase();
      const rows = (await store.allContacts(ws))
        .filter((c) => !req.filter?.accountId || c.accountId === req.filter.accountId)
        .filter((c) => !req.filter?.scope || ownerAdmitted(req.filter.scope, c.ownerId))
        .filter((c) => !q || lower(c.fullName).includes(q) || lower(c.title).includes(q) || lower(c.email).includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      return pageOf(rows, req.cursor, req.limit);
    },
    async get(ws, id) {
      const account = await store.getAccount(ws, id);
      if (!account) return null;
      const [contacts, history] = await Promise.all([store.contactsFor(ws, id), store.history(ws, id)]);
      return { account, contacts, history };
    },
    getContact: (ws, id) => store.getContact(ws, id),
    async upsertAccounts(ws, body) {
      const seen = await store.seenKey(ws, body.idempotencyKey);
      if (seen) return seen;
      const t = now();
      const ids = body.records.map((r) => accountIdFor(r.domain));
      const existing = await store.getAccountsByIds(ws, ids);
      const rows = body.records.map((input, i) => mergeAccount(existing.get(ids[i]) ?? null, input, body.source, t, body.fill));
      await store.putAccounts(ws, rows);
      const response = { upserted: rows.length, ids };
      await store.rememberKey(ws, body.idempotencyKey, response);
      return response;
    },
    async upsertContacts(ws, body) {
      const seen = await store.seenKey(ws, body.idempotencyKey);
      if (seen) return seen;
      const t = now();
      const rows: ContactRow[] = [];
      // fill: "missing" (contract 1.5.0): an existing contact keeps every non-empty value.
      const existing = new Map<string, ContactRow>();
      if (body.fill === "missing") {
        const accountIds = new Set(body.records.map((r) => r.accountId ?? (r.accountDomain ? accountIdFor(r.accountDomain) : "")).filter(Boolean));
        for (const accountId of accountIds) for (const c of await store.contactsFor(ws, accountId)) existing.set(c.id, c);
      }
      for (const input of body.records) {
        const accountId = input.accountId ?? (input.accountDomain ? accountIdFor(input.accountDomain) : undefined);
        if (!accountId) throw new Error("contacts/upsert: each contact needs accountId or accountDomain");
        const row = contactRowFrom(input, accountId, t);
        const prior = existing.get(row.id);
        rows.push(prior ? fillMissing(prior, row, t) : row);
      }
      await store.putContacts(ws, rows);
      const response = { upserted: rows.length, ids: rows.map((r) => r.id) };
      await store.rememberKey(ws, body.idempotencyKey, response);
      return response;
    },
    async edit(ws, body) { return store.edit(ws, body, now()); },
    async countSegment(ws, filter) {
      return { total: (await store.allAccounts(ws)).filter((row) => matchesFilter(row, filter)).length };
    },
    async facets(ws, req) {
      return facetRows((await store.allAccounts(ws)).filter((row) => matchesFilter(row, req.filter)), req);
    },
    async annotate(ws, records) {
      const byDomain = records.some((r) => !r.id)
        ? new Map((await store.allAccounts(ws)).map((row) => [row.domain.toLowerCase(), row]))
        : new Map<string, AccountRow>();
      const byId = await store.getAccountsByIds(ws, records.flatMap((r) => (r.id ? [r.id] : [])));
      const changed = new Map<string, AccountRow>();
      const missing: string[] = [];
      for (const rec of records) {
        const found = rec.id ? byId.get(rec.id) : byDomain.get(normalizeDomain(rec.domain ?? ""));
        if (!found) {
          missing.push((rec.id ?? rec.domain)!);
          continue;
        }
        const row = annotateRow(changed.get(found.id) ?? found, rec);
        changed.set(row.id, row);
      }
      await store.putAccounts(ws, [...changed.values()]);
      return { updated: records.length - missing.length, missing };
    },
    async searchShared(filter, limit, rank) {
      // The fixture has no company_tags; behave like a service whose index lacks them.
      if (filter.archetype?.length) throw new Error("record service 422: archetype filter needs a prospect index with company_tags");
      const matches = shared().filter((row) => matchesFilter(row, { ...filter, segmentId: undefined, status: undefined, ownerId: undefined, minFit: undefined }));
      const rows = rank
        ? matches.map((row) => ({ ...row, fit: fitUnderWeights(row, rank) })).sort((a, b) => b.fit - a.fit || (b.employees ?? 0) - (a.employees ?? 0) || a.domain.localeCompare(b.domain))
        : matches;
      return { rows: rows.slice(0, limit), total: matches.length };
    },
    async lookupShared(domains) {
      const wanted = new Set(domains.map((d) => d.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/[/:?#].*$/, "")));
      return pdlSampleDetails().filter((row) => wanted.has(row.domain));
    },
    async marketFacets(filter, groupBy, limit = 200) {
      const r = facetRows(shared().filter((row) => matchesFilter(row, filter)), { groupBy, limit });
      return { groups: r.groups.map((g) => ({ key: g.key, count: g.count })), total: r.total, truncated: r.truncated };
    },
    async rescore(ws, icp, version, gates) {
      const result = await store.rescore(ws, icp, version, gates);
      gatesByWs.set(ws, result.gates);
      return { rescored: result.rescored };
    },
    async icpStats(ws) {
      const rows = await store.allAccounts(ws);
      return { gates: (gatesByWs.get(ws) ?? []).map((g) => ({ id: g.id, members: rows.filter((r) => r.icpIds?.includes(g.id)).length, unverified: 0 })) };
    },
    async icpTreeCounts(ws, req) {
      const accounts = (await store.allAccounts(ws)).filter((a) => !req.accountScope || ownerAdmitted(req.accountScope, a.ownerId));
      const contacts = (await store.allContacts(ws)).filter((c) => !req.contactScope || ownerAdmitted(req.contactScope, c.ownerId));
      return countIcpTree(accounts, contacts, req.nodes);
    },
    async territoryTreeCounts(ws, req) {
      const accounts = (await store.allAccounts(ws)).filter((a) => !req.accountScope || ownerAdmitted(req.accountScope, a.ownerId));
      const problem = territoryTreeProblem(req);
      if (problem) throw new Error(problem);
      return countTerritoryTree(accounts, req);
    },
    async listObjects(ws, object, req) {
      const source = objects ? await objects.rows(ws, [object]) : { rows: [], defs: [], heads: {} };
      const def = source.defs.find((d) => d.apiName === object);
      if (!def) return { rows: [], nextCursor: null, total: 0, projectedThrough: throughAll(source.heads) };
      return listRowsInMemory(indexObjectDef(def), source.rows, req, throughAll(source.heads));
    },
    async searchObjects(ws, req) {
      // As the service does: accounts and contacts from the register, other objects from their rows.
      const s = compileSearch(req);
      const want = (o: string) => !s.objects || s.objects.includes(o);
      const source = objects ? await objects.rows(ws, s.objects) : { rows: [], heads: {} };
      const found = searchRowsInMemory(source.rows.filter((r) => !isRegisterObject(r.object)), { ...req, perObject: s.limit }, {}).hits;
      const has = (...texts: (string | undefined)[]) => texts.some((t) => t?.toLowerCase().includes(s.q));
      const accounts = await store.allAccounts(ws);
      for (const a of want("account") ? accounts : []) {
        if (has(a.name, a.domain) && searchAdmits(s, "account", a.ownerId)) found.push({ object: "account", id: a.id, title: a.name, updatedAt: a.updatedAt, detail: { domain: a.domain } });
      }
      const company = new Map(accounts.map((a) => [a.id, a.name]));
      for (const p of want("contact") ? await store.allContacts(ws) : []) {
        const detail = { email: p.email || null, company: company.get(p.accountId) ?? null };
        if (has(p.fullName, p.email) && searchAdmits(s, "contact", p.ownerId)) found.push({ object: "contact", id: p.id, title: p.fullName, updatedAt: p.updatedAt, detail });
      }
      return { hits: rankSearchHits(found, s), projectedThrough: throughAll(source.heads) };
    },
    async listRegister(ws, object, req) {
      const def = registerListDef(object, resolveObjectDef(STANDARD_OBJECTS[object]));
      const rows = await registerRows(ws, object, def);
      const email = object === "contact" ? def.fields.find((f) => f.apiName === "email")?.fieldId : undefined;
      if (!email) return listRowsInMemory(def, rows, req, throughAll({})) as RegisterListResponse;
      // An email matches whatever its case, as in the service (1.13.0).
      const lower = <T,>(v: T) => (typeof v === "string" ? v.toLowerCase() : v);
      const filter = req.filter?.map((f) => (f.field === "email" && ["eq", "neq", "in"].includes(f.op) ? { ...f, value: Array.isArray(f.value) ? f.value.map(lower) : lower(f.value) } : f));
      const lowered = rows.map((r) => ({ ...r, values: { ...r.values, [email]: lower(r.values[email]) } }));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const page = listRowsInMemory(def, lowered, { ...req, ...(filter ? { filter } : {}) }, throughAll({})) as RegisterListResponse;
      return { ...page, rows: page.rows.map((r) => byId.get(r.id) ?? r) };
    },
    async moduleSync(_ws, body) {
      if (body.projection) throw new Error("The fake record client does not implement projection receipts.");
      return { at: now(), upserted: body.upserts.length, deleted: body.deletes.length };
    },
    moduleAggregate: async () => { throw new Error("The fake record client keeps no module docs: a module report reads them in Convex."); },
    async aggregate(ws, object, req) {
      if (req.moduleActivities?.length) throw new Error("The fake record client cannot report projected module activities.");
      const source = objects ? await objects.rows(ws, null) : { rows: [], defs: [], heads: {} };
      const defs = new Map(source.defs.map((d) => [d.apiName, indexObjectDef(d)]));
      const defOf = (o: string) => (o === ACTIVITY_OBJECT ? activityReportDef() : isRegisterObject(o) ? registerListDef(o, resolveObjectDef(STANDARD_OBJECTS[o])) : defs.get(o));
      // Activities are every note, task, call and meeting, typed by which it is, as the service's union reads them.
      const activities = () => source.rows.filter((r) => (ACTIVITY_TYPES as readonly string[]).includes(r.object))
        .map((r) => ({ ...r, object: ACTIVITY_OBJECT, values: { type: r.object, ownerId: r.values.ownerId ?? null } }));
      const rowsOf = async (o: string) => (o === ACTIVITY_OBJECT ? activities() : isRegisterObject(o) ? registerRows(ws, o, defOf(o)!) : source.rows.filter((r) => r.object === o));
      const def = defOf(object);
      if (!def) return { groups: [], subtotals: [], total: req.measures.map((m) => (m.fn === "count" ? 0 : null)), rows: 0, truncated: false, projectedThrough: throughAll(source.heads) };
      const q = compileAggregateRequest(object, def, req, defOf);
      const related = new Map<string, Map<string, ListRow>>();
      for (const g of q.groups) if (g.via && !related.has(g.object)) related.set(g.object, new Map((await rowsOf(g.object)).map((r) => [r.id, r])));
      return aggregateRowsInMemory(q, await rowsOf(object), (o) => related.get(o) ?? new Map(), throughAll(source.heads));
    },
    async matchInbound(ws, input) {
      const source = objects ? await objects.rows(ws, ["lead"]) : { rows: [] };
      return matchInbound(input, await store.allAccounts(ws), await store.allContacts(ws), source.rows.filter((r) => r.object === "lead" && r.status === "active").map((r) => ({ id: r.id, email: typeof r.values.email === "string" ? r.values.email : null })));
    },
    async listDuplicates(ws, object, limit, scope) {
      const rows = object === "account"
        ? (await store.allAccounts(ws)).filter((a) => !scope || ownerAdmitted(scope, a.ownerId)).map((a) => ({ id: a.id, name: a.name, domain: a.domain, linkedinUrl: a.linkedinUrl, detail: a.industry }))
        : (await store.allContacts(ws)).filter((c) => !scope || ownerAdmitted(scope, c.ownerId)).map((c) => ({ id: c.id, name: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl, accountId: c.accountId, detail: c.title }));
      const groups = findDuplicates(object as DuplicateObject, rows);
      return { groups: groups.slice(0, limit), total: groups.length };
    },
    async nudgeProjector() {},
  };
}

/** A fill-only merge: the existing row's non-empty values win, the incoming row fills the gaps. */
function fillMissing(prior: ContactRow, incoming: ContactRow, now: number): ContactRow {
  const merged: ContactRow = { ...prior, updatedAt: now };
  for (const f of ["title", "email", "emailStatus", "linkedinUrl"] as const) {
    if (prior[f] === undefined || prior[f] === null || prior[f] === "") (merged as Record<string, unknown>)[f] = incoming[f];
  }
  return merged;
}

export function contactRowFrom(input: ContactInput, accountId: string, now: number): ContactRow {
  return {
    id: contactIdFor(accountId, input.fullName, input.email),
    accountId,
    fullName: input.fullName,
    title: input.title,
    email: input.email,
    emailStatus: input.emailStatus,
    linkedinUrl: input.linkedinUrl,
    status: "new",
    updatedAt: now,
  };
}

/**
 * Employer names for one page of contacts. A contact can have no account (accountId ""),
 * which the record service rejects as a lookup id, so those are skipped.
 */
export async function accountNamesFor(client: Pick<RecordClient, "get">, ws: string, accountIds: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const ids = [...new Set(accountIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 10) {
    const got = await Promise.all(ids.slice(i, i + 10).map((id) => client.get(ws, id)));
    got.forEach((detail, j) => { if (detail) names[ids[i + j]] = detail.account.name; });
  }
  return names;
}

/** Employer names for many contacts: a register page of accounts per request, not one request per account. */
export async function accountNamesByList(client: Pick<RecordClient, "listRegister">, ws: string, accountIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  const size = Math.min(IN_VALUES_MAX, LIST_LIMIT_MAX);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const names: Record<string, string> = {};
  for (let i = 0; i < chunks.length; i += 5) {
    const pages = await Promise.all(chunks.slice(i, i + 5).map((chunk) => client.listRegister(ws, "account", { filter: [{ field: "id", op: "in", value: chunk }], limit: chunk.length })));
    for (const page of pages) for (const row of page.rows) if (row.title) names[row.id] = row.title;
  }
  return names;
}

// ───────────────────────────── HTTP client ─────────────────────────────

/** Max rows the deployed record service returns from shared prospect search. */
export const SHARED_SEARCH_MAX = 200;

export function createHttpRecordClient(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): RecordClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  async function call<T>(path: string, ws: string | null, body: unknown, allow404 = false, provisioned = false): Promise<T | null> {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
        ...(ws ? { "X-Workspace-Id": ws } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
      // Only the claim-time import provisions a workspace, so an org that hasn't claimed
      // a session (or whose import is still waiting) has none yet. Provisioning is
      // idempotent: create it, then retry once. An empty workspace answers empty.
      const provisionPath = ws ? `${w(ws)}/provision` : null;
      if (response.status === 404 && ws && !provisioned && path !== provisionPath && detail.includes("workspace not provisioned")) {
        await call(provisionPath!, ws, {}, false, true);
        return call<T>(path, ws, body, allow404, true);
      }
      if (allow404 && response.status === 404) return null;
      throw new Error(`record service ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return (await response.json()) as T;
  }
  const w = (ws: string) => `/v1/workspaces/${encodeURIComponent(ws)}`;
  /** A projection route: the service's 400 is a request the shared list semantics rejected, so it surfaces as ListRequestError like the fake's. */
  async function projection<T>(path: string, ws: string, body: unknown): Promise<T> {
    try {
      return (await call<T>(`${w(ws)}${path}`, ws, body))!;
    } catch (e) {
      const m = /HTTP 400 (\{[\s\S]*\})$/.exec(String((e as Error).message));
      if (m) {
        let detail = "invalid request";
        try { detail = (JSON.parse(m[1]) as { error?: string }).error ?? detail; } catch { /* keep the generic message */ }
        throw new ListRequestError(detail);
      }
      throw e;
    }
  }
  // The service scores 0..100; the app (UI, sorting, minFit) works in 0..1.
  const toUnit = <T extends { fit?: number }>(row: T): T => (row.fit === undefined || row.fit === null ? row : { ...row, fit: row.fit / 100 });
  const withFilterFit = (filter: AccountsFilter | undefined) =>
    filter?.minFit === undefined ? filter : { ...filter, minFit: filter.minFit * 100 };
  const contractVersion = async () => {
    try {
      const res = await fetchImpl(`${base}/healthz`, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const version = String(((await res.json()) as { version?: unknown }).version ?? "");
      return /^\d+\.\d+\.\d+/.exec(version)?.[0] ?? null;
    } catch {
      return null;
    }
  };
  return {
    mode: "http",
    contractVersion,
    prepareResearch: async (body) => (await call<{ total: number }>("/v1/research/prepare", null, body))!,
    commitResearch: async (ws, sessionId) => (await call<{ importedAccounts: number; total: number; done: boolean }>(`${w(ws)}/research/commit`, ws, { sessionId }))!,
    provision: async (ws) => (await call<{ created: boolean }>(`${w(ws)}/provision`, ws, {}))!,
    list: async (ws, req) => {
      const r = (await call<AccountsListResponse>(`${w(ws)}/accounts/list`, ws, { ...req, filter: withFilterFit(req.filter) }))!;
      return { ...r, rows: r.rows.map(toUnit) };
    },
    listContacts: async (ws, req) => (await call<ContactsListResponse>(`${w(ws)}/contacts/list`, ws, req))!,
    get: async (ws, id) => {
      const r = await call<GetResponse>(`${w(ws)}/accounts/get`, ws, { id }, true);
      return r && { ...r, account: toUnit(r.account) };
    },
    getContact: async (ws, id) => (await call<GetContactResponse>(`${w(ws)}/contacts/get`, ws, { id }, true))?.contact ?? null,
    upsertAccounts: async (ws, body) => (await call<UpsertResponse>(`${w(ws)}/accounts/upsert`, ws, body))!,
    upsertContacts: async (ws, body) => (await call<UpsertResponse>(`${w(ws)}/contacts/upsert`, ws, body))!,
    edit: async (ws, body) => (await call<EditResponse>(`${w(ws)}/records/edit`, ws, body))!,
    countSegment: async (ws, filter) => (await call<{ total: number }>(`${w(ws)}/segments/count`, ws, { filter: withFilterFit(filter) }))!,
    rescore: async (ws, icp, version, gates) => (await call<{ rescored: number }>(`${w(ws)}/rescore`, ws, { icp, version, ...(gates ? { gates } : {}) }))!,
    icpStats: async (ws) => (await call<IcpStats>(`${w(ws)}/icp-stats`, ws, {}, true)) ?? { gates: [] },
    icpTreeCounts: async (ws, req) => (await call<IcpTreeCounts>(`${w(ws)}/icp-tree/counts`, ws, req))!,
    territoryTreeCounts: async (ws, req) => (await call<TerritoryTreeResult>(`${w(ws)}/territory-tree/counts`, ws, req))!,
    facets: async (ws, req) => (await call<FacetsResponse>(`${w(ws)}/accounts/facets`, ws, { ...req, filter: withFilterFit(req.filter) }))!,
    annotate: async (ws, records) => {
      const out: AnnotateResponse = { updated: 0, missing: [] };
      for (let i = 0; i < records.length; i += 2000) {
        const r = (await call<AnnotateResponse>(`${w(ws)}/accounts/annotate`, ws, { records: records.slice(i, i + 2000) }))!;
        out.updated += r.updated;
        out.missing.push(...r.missing);
      }
      return out;
    },
    listObjects: (ws, object, req) => projection<ListResponse>(`/p/${encodeURIComponent(object)}/list`, ws, req),
    searchObjects: (ws, req) => projection<SearchResponse>("/p/search", ws, req),
    listRegister: (ws, object, req) => projection<RegisterListResponse>(`/register/${object}/list`, ws, req),
    moduleSync: async (ws, { module, ...body }) => (await call<ModuleSyncResponse>(`${w(ws)}/modules/${encodeURIComponent(module)}/sync`, ws, body))!,
    // A field's label (up to 200 characters in a manifest) names it for people; the service reads at most 80 of it.
    moduleAggregate: async (ws, { module, ...body }) => {
      const out = await projection<AggregateResponse & { projection?: ModuleProjection }>(`/modules/${encodeURIComponent(module)}/aggregate`, ws, { ...body, fields: body.fields.map((f) => ({ ...f, label: f.label.slice(0, 80) })) });
      if (body.projection && !sameProjection(body.projection, out.projection)) throw new Error("Module reports need record service 1.43.0 with projection receipts.");
      return out;
    },
    aggregate: async (ws, object, req) => {
      if (req.moduleActivities?.length && (object !== ACTIVITY_OBJECT || !atLeastVersion(await contractVersion(), "1.44.0"))) throw new Error("Module activity reports need record service 1.44.0 or newer.");
      const out = await projection<AggregateResponse & Partial<ActivityAggregateReceipt>>(isRegisterObject(object) ? `/register/${object}/aggregate` : `/p/${encodeURIComponent(object)}/aggregate`, ws, req);
      if (req.moduleActivities?.length && canonicalJson(req.moduleActivities) !== canonicalJson(out.moduleActivities ?? null)) throw new Error("Module activity reports need the complete record service 1.44.0 source receipt.");
      const result = { ...out };
      delete result.moduleActivities;
      return result;
    },
    matchInbound: async (ws, input) => {
      if (!atLeastVersion(await contractVersion(), "1.42.0")) throw new Error("Inbound matching needs record service 1.42.0 or newer.");
      return (await call<InboundMatch>(`${w(ws)}/match/inbound`, ws, input))!;
    },
    listDuplicates: async (ws, object, limit, scope) => (await call<{ groups: DuplicateGroup[]; total: number }>(`${w(ws)}/register/${object}/duplicates`, ws, { limit, ...(scope ? { scope } : {}) }))!,
    nudgeProjector: async (ws, heads, source, opts) => {
      await call(`${w(ws)}/projector/nudge`, ws, { heads, ...(source ? { source } : {}), ...(opts?.wait ? { wait: true } : {}) });
    },
    marketFacets: async (filter, groupBy, limit) =>
      (await call<MarketFacetsResponse>(`/v1/shared/prospects/facets`, null, {
        filter: { industry: filter.industry, country: filter.country, region: filter.region, sizeBand: filter.sizeBand },
        groupBy,
        ...(limit ? { limit } : {}),
      }))!,
    lookupShared: async (domains) => {
      const rows: SharedCompanyDetail[] = [];
      for (let i = 0; i < domains.length; i += 1000) {
        rows.push(...(await call<{ rows: SharedCompanyDetail[] }>(`/v1/shared/prospects/lookup`, null, { domains: domains.slice(i, i + 1000) }))!.rows);
      }
      return rows;
    },
    // Service caps prospect search at 200 rows and accepts only these filter keys.
    searchShared: async (filter, limit, rank) => {
      const r = (await call<SharedSearchResponse>(`/v1/shared/prospects/search`, null, {
        filter: {
          q: filter.q,
          industry: filter.industry,
          country: filter.country,
          employeeMin: filter.employeeMin,
          employeeMax: filter.employeeMax,
          archetype: filter.archetype,
          minArchetypeP: filter.minArchetypeP,
        },
        limit: Math.max(1, Math.min(limit, SHARED_SEARCH_MAX)),
        ...(rank ? { rank } : {}),
      }))!;
      return { ...r, rows: r.rows.map(toUnit) };
    },
  };
}

/**
 * Entry point. `store` is the fake's persistence (Convex callers pass the
 * table-backed store from convex/records.ts; tests pass a memory store).
 */
/**
 * The fake implements 1.42.0. It has no module projection store or 1.43.0 receipts;
 * it has no projector, so it keeps no register (1.8.0's write-back): records.edit sends it every field (convex/records.ts).
 */
export const FAKE_CONTRACT_VERSION = "1.42.0";

/** True when `version` is at least `min` (both "major.minor.patch"). */
export function atLeastVersion(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

export function recordClient(opts: {
  store?: FakeRecordStore;
  objects?: FakeObjectSource;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): RecordClient {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const url = env.RECORD_SERVICE_URL;
  if (url) {
    const token = env.RECORD_SERVICE_TOKEN;
    if (!token) throw new Error("RECORD_SERVICE_URL is set but RECORD_SERVICE_TOKEN is missing.");
    return createHttpRecordClient({ baseUrl: url, token, fetchImpl: opts.fetchImpl });
  }
  return createFakeRecordClient({ store: opts.store ?? defaultMemoryStore(), objects: opts.objects, now: opts.now });
}

let memoryStore: FakeRecordStore | null = null;
function defaultMemoryStore() {
  memoryStore ??= createMemoryRecordStore();
  return memoryStore;
}

// ───────────────────────────── Synthetic PDL fixture ─────────────────────────────
//
// FIXTURE, NOT REAL DATA. Companies below are generated deterministically and
// use the reserved `.example` TLD so they can never be mistaken for real
// firms. The record shape mirrors the People Data Labs free company dataset
// (CC BY 4.0): id, name, website, size, founded, industry, locality, region,
// country, linkedin_url. tests/fixtures/pdl-sample.json is this generator's
// output; tests/crmRecordClient.test.ts regenerates it and asserts equality.

export type PdlCompany = {
  id: string;
  name: string;
  website: string;
  size: string;
  founded: number | null;
  industry: string;
  locality: string | null;
  region: string | null;
  country: string;
  linkedin_url: string;
};

export const PDL_SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"] as const;

export const PDL_INDUSTRIES = [
  "computer software", "internet", "information technology and services", "financial services",
  "marketing and advertising", "hospital & health care", "staffing and recruiting", "management consulting",
  "real estate", "retail", "e-learning", "logistics and supply chain", "insurance", "telecommunications",
  "construction", "accounting", "banking", "biotechnology", "automotive", "consumer goods",
] as const;

const COUNTRIES: Array<[string, number, Array<[string, string]>]> = [
  ["united states", 52, [["san francisco", "california"], ["new york", "new york"], ["austin", "texas"], ["chicago", "illinois"], ["boston", "massachusetts"], ["seattle", "washington"], ["denver", "colorado"], ["atlanta", "georgia"]]],
  ["united kingdom", 10, [["london", "england"], ["manchester", "england"], ["edinburgh", "scotland"]]],
  ["canada", 7, [["toronto", "ontario"], ["vancouver", "british columbia"], ["montreal", "quebec"]]],
  ["germany", 6, [["berlin", "berlin"], ["munich", "bavaria"], ["hamburg", "hamburg"]]],
  ["france", 4, [["paris", "ile-de-france"], ["lyon", "auvergne-rhone-alpes"]]],
  ["australia", 5, [["sydney", "new south wales"], ["melbourne", "victoria"]]],
  ["netherlands", 4, [["amsterdam", "north holland"], ["rotterdam", "south holland"]]],
  ["india", 6, [["bengaluru", "karnataka"], ["mumbai", "maharashtra"], ["pune", "maharashtra"]]],
  ["singapore", 3, [["singapore", "singapore"]]],
  ["ireland", 3, [["dublin", "leinster"], ["cork", "munster"]]],
];

const SIZE_WEIGHTS = [30, 26, 18, 10, 6, 6, 2, 2];
const INDUSTRY_WEIGHTS = [14, 10, 10, 6, 7, 6, 4, 5, 4, 4, 3, 4, 3, 3, 3, 3, 2, 3, 3, 3];

const NAME_A = ["North", "Blue", "Iron", "Bright", "Clear", "Silver", "Summit", "Harbor", "Pioneer", "Quantum", "Cedar", "Atlas", "Lumen", "Vector", "Granite", "Maple", "Nimbus", "Orbit", "Prairie", "Redwood", "Sable", "Tidal", "Union", "Vivid", "Willow", "Zephyr", "Copper", "Delta", "Ember", "Falcon", "Golden", "Hollow"];
const NAME_B = ["wind", "field", "stone", "bridge", "path", "point", "crest", "line", "gate", "works", "spring", "light", "peak", "forge", "wave", "grid", "loop", "leaf", "ridge", "harbor"];
const INDUSTRY_SUFFIX: Record<string, string[]> = {
  "computer software": ["Software", "Labs", "Cloud", "Systems"],
  internet: ["Digital", "Online", "Networks"],
  "information technology and services": ["IT", "Technologies", "Solutions"],
  "financial services": ["Capital", "Financial", "Partners"],
  "marketing and advertising": ["Media", "Marketing", "Creative"],
  "hospital & health care": ["Health", "Care", "Medical"],
  "staffing and recruiting": ["Talent", "Staffing", "Recruiting"],
  "management consulting": ["Consulting", "Advisory", "Group"],
  "real estate": ["Realty", "Properties", "Estates"],
  retail: ["Goods", "Outfitters", "Market"],
  "e-learning": ["Learning", "Academy", "EDU"],
  "logistics and supply chain": ["Logistics", "Freight", "Supply"],
  insurance: ["Insurance", "Assurance", "Mutual"],
  telecommunications: ["Telecom", "Connect", "Wireless"],
  construction: ["Builders", "Construction", "Contracting"],
  accounting: ["Accounting", "CPAs", "Ledger"],
  banking: ["Bank", "Bancorp", "Trust"],
  biotechnology: ["Bio", "Therapeutics", "Genomics"],
  automotive: ["Motors", "Automotive", "Mobility"],
  "consumer goods": ["Brands", "Co", "Goods"],
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function weighted<T>(rand: () => number, items: readonly T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rand() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll < 0) return items[i];
  }
  return items[items.length - 1];
}

export const PDL_SAMPLE_SIZE = 3000;
export const PDL_SAMPLE_SEED = 20261001;

export function generatePdlSample(count = PDL_SAMPLE_SIZE, seed = PDL_SAMPLE_SEED): PdlCompany[] {
  const rand = mulberry32(seed);
  const used = new Set<string>();
  const out: PdlCompany[] = [];
  for (let i = 0; out.length < count && i < count * 20; i++) {
    const industry = weighted(rand, PDL_INDUSTRIES, INDUSTRY_WEIGHTS);
    const [country, , cities] = weighted(rand, COUNTRIES, COUNTRIES.map((c) => c[1]));
    const [locality, region] = cities[Math.floor(rand() * cities.length)];
    const a = NAME_A[Math.floor(rand() * NAME_A.length)];
    const b = NAME_B[Math.floor(rand() * NAME_B.length)];
    const suffixes = INDUSTRY_SUFFIX[industry];
    const suffix = suffixes[Math.floor(rand() * suffixes.length)];
    let name = `${a}${b} ${suffix}`;
    let slug = `${a}${b}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (used.has(slug)) {
      const n = 2 + Math.floor(rand() * 98);
      name = `${name} ${n}`;
      slug = `${slug}${n}`;
      if (used.has(slug)) continue;
    }
    used.add(slug);
    const size = weighted(rand, PDL_SIZE_BANDS, SIZE_WEIGHTS);
    out.push({
      id: `fixture-${out.length.toString(36).padStart(4, "0")}`,
      name: name.toLowerCase(), // PDL ships lowercased names
      website: `${slug}.example`,
      size,
      founded: rand() < 0.15 ? null : 1960 + Math.floor(rand() * 64),
      industry,
      locality: rand() < 0.05 ? null : locality,
      region: rand() < 0.05 ? null : region,
      country,
      linkedin_url: `linkedin.com/company/${slug}-fixture`,
    });
  }
  return out;
}

const BAND_MIDPOINT: Record<string, number> = {
  "1-10": 6, "11-50": 30, "51-200": 120, "201-500": 350, "501-1000": 750,
  "1001-5000": 2500, "5001-10000": 7500, "10001+": 15000,
};

function titleCase(value: string) {
  return value.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, "and");
}

export function pdlToAccountInput(company: PdlCompany): AccountInput {
  return {
    domain: company.website.toLowerCase(),
    name: titleCase(company.name),
    industry: company.industry,
    employees: BAND_MIDPOINT[company.size],
    country: company.country,
    linkedinUrl: company.linkedin_url ? `https://${company.linkedin_url}` : undefined,
  };
}

let sampleCache: AccountInput[] | null = null;
export function pdlSampleAccounts(): AccountInput[] {
  sampleCache ??= generatePdlSample().map(pdlToAccountInput);
  return sampleCache;
}

let detailCache: SharedCompanyDetail[] | null = null;
/** The synthetic sample as lookup rows, shaped like the service's (lowercase values, bare LinkedIn URL like the built index). */
export function pdlSampleDetails(): SharedCompanyDetail[] {
  detailCache ??= generatePdlSample().map((c) => {
    const [min, max] = c.size.split(/[-+]/).map((n) => (n ? Number(n) : undefined));
    return {
      domain: c.website.toLowerCase(), name: c.name, industry: c.industry, country: c.country,
      region: c.region ?? undefined, locality: c.locality ?? undefined, linkedinUrl: c.linkedin_url ?? undefined,
      founded: c.founded ?? undefined, sizeBand: c.size, employeesMin: min, employeesMax: max, domainConfidence: "high" as const,
    };
  });
  return detailCache;
}
