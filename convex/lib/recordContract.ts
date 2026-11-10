/**
 * Record-service HTTP contract: client-side mirror of
 * `services/record-service/src/contract.ts` (contract 1.1.0). Not verbatim:
 *  - `contacts/list` was added to the service at integration (1.1.0).
 *  - Service history rows carry `seq`, not `version`.
 *  - Shared prospect search is capped at 200 rows server-side; the HTTP
 *    client clamps (see SHARED_SEARCH_MAX in recordClient.ts).
 *  - Account `fit` sent on upsert is ignored by the service (it computes fit
 *    0-100 from ICP weights via `rescore`).
 */
import { z } from "zod";
import type { TerritoryCriteria } from "../../services/record-service/src/territoryTree.ts";

export const AccountStatus = z.enum(["new", "working", "qualified", "disqualified"]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const AccountInput = z.object({
  domain: z.string().min(1),
  name: z.string().min(1),
  /** Upsert only (service 1.5.0): replace an existing name only while it still equals this placeholder. */
  nameIfCurrently: z.string().optional(),
  industry: z.string().optional(),
  employees: z.number().int().nonnegative().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().optional(),
  fit: z.number().min(0).max(1).optional(),
  segmentIds: z.array(z.string()).optional(),
  status: AccountStatus.optional(),
  ownerId: z.string().optional(),
});
export type AccountInput = z.infer<typeof AccountInput>;

export const ContactInput = z.object({
  accountId: z.string().optional(),
  accountDomain: z.string().optional(),
  fullName: z.string().min(1),
  title: z.string().optional(),
  email: z.string().optional(),
  emailStatus: z.string().optional(),
  linkedinUrl: z.string().optional(),
});
export type ContactInput = z.infer<typeof ContactInput>;

export const AccountRow = z.object({
  id: z.string(),
  domain: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  employees: z.number().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().optional(),
  fit: z.number(),
  status: AccountStatus,
  ownerId: z.string().optional(),
  segmentIds: z.array(z.string()),
  source: z.string(),
  updatedAt: z.number(),
  version: z.number(),
  /** Service 1.4.0+: annual revenue (USD), its source, and derived traits (Jev segment answers). */
  revenue: z.number().optional(),
  revenueSource: z.enum(["crm", "estimate"]).optional(),
  revenueConfidence: z.number().optional(),
  traits: z.record(z.string(), z.string()).optional(),
  /** Service 1.8.0+: the ledger stream this row is linked to (one register), and the stream version last written back. */
  stream: z.string().optional(),
  ledgerVersion: z.number().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  description: z.string().optional(),
  annualRevenue: z.number().optional(),
  /** Service 1.14.0+: the saved ICPs (icps ids) this account passes as a whole. */
  icpIds: z.array(z.string()).optional(),
  /** When each field was last set (epoch ms); the fake client leaves it out. */
  fieldUpdatedAt: z.record(z.string(), z.number()).optional(),
});
export type AccountRow = z.infer<typeof AccountRow>;

export const ContactRow = z.object({
  id: z.string(),
  accountId: z.string(),
  fullName: z.string(),
  title: z.string().optional(),
  email: z.string().optional(),
  emailStatus: z.string().optional(),
  linkedinUrl: z.string().optional(),
  status: z.string(),
  updatedAt: z.number(),
  /** Service 1.8.0+: see AccountRow. */
  stream: z.string().optional(),
  ledgerVersion: z.number().optional(),
  phone: z.string().optional(),
  ownerId: z.string().optional(),
  lifecycleStage: z.string().optional(),
  leadStatus: z.string().optional(),
});
export type ContactRow = z.infer<typeof ContactRow>;

export const FieldHistoryRow = z.object({
  object: z.enum(["account", "contact"]),
  id: z.string(),
  field: z.string(),
  oldValue: z.union([z.string(), z.number(), z.null()]),
  newValue: z.union([z.string(), z.number(), z.null()]),
  actorId: z.string(),
  /** Write origin ("fsgtm", "salesforce", ...), sent by the service only. */
  source: z.string().optional(),
  at: z.number(),
  version: z.number(),
});
export type FieldHistoryRow = z.infer<typeof FieldHistoryRow>;

export const AccountsFilter = z.object({
  segmentId: z.string().optional(),
  status: AccountStatus.optional(),
  ownerId: z.string().optional(),
  minFit: z.number().optional(),
  q: z.string().optional(),
  industry: z.array(z.string()).optional(),
  country: z.array(z.string()).optional(),
  employeeMin: z.number().optional(),
  employeeMax: z.number().optional(),
  /** Service 1.4.0+ (TAM explorer). Lists accept "__none__" for "no value", as do industry, country and segmentId. */
  sizeBand: z.array(z.string()).optional(),
  region: z.array(z.string()).optional(),
  traits: z.record(z.string(), z.array(z.string())).optional(),
  /** Service 1.14.0+: accounts inside this saved ICP (icps id). */
  icpId: z.string().optional(),
  /** Service 1.21.0+: AI-field slug -> accepted answers (any of; "__none__" = not answered). */
  custom: z.record(z.string(), z.array(z.string())).optional(),
  /** Shared prospect search only (service 1.3.0+): business types from company_tags. */
  archetype: z.array(z.string()).optional(),
  minArchetypeP: z.number().optional(),
  /** Service 1.29.0+ (CP14): only accounts the caller may see (lib/access.ts ownerScope over `ownerId`). */
  scope: z.object({ field: z.literal("ownerId"), owners: z.array(z.string()), unowned: z.boolean() }).optional(),
  /** Service 1.40.0+: company criteria from query lines (lib/icpQuery.ts accountCriteria), every one of which must pass. */
  criteria: z.array(z.custom<TerritoryCriteria>()).optional(),
});
export type AccountsFilter = z.infer<typeof AccountsFilter>;

export const AccountsSort = z.object({
  field: z.enum(["fit", "name", "employees", "updatedAt"]),
  dir: z.enum(["asc", "desc"]),
});
export type AccountsSort = z.infer<typeof AccountsSort>;

export const AccountsListRequest = z.object({
  filter: AccountsFilter.optional(),
  sort: AccountsSort.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type AccountsListRequest = z.infer<typeof AccountsListRequest>;

/** Service 1.4.0: `trait:<key>` groups by a trait's value. */
export type FacetDimension = "industry" | "sizeBand" | "region" | "country" | "segment" | `trait:${string}` | `field:${string}`;
export type FacetsRequest = { filter?: AccountsFilter; groupBy: FacetDimension; limit?: number };
/** Service 1.19.0: market sizes, the shared prospect index grouped on the same keys workspace facets use. */
export type MarketDimension = "industry" | "country" | "region" | "sizeBand";
export type MarketFilter = Pick<AccountsFilter, "industry" | "country" | "region" | "sizeBand">;
export type MarketFacetsResponse = { groups: Array<{ key: string; count: number }>; total: number; truncated: boolean };
/** `employees`: sum of known employee counts (sizes the treemap's opportunity metric). */
export type FacetGroup = { key: string; count: number; revenue: number; revenueKnown: number; employees: number };
export type FacetsResponse = { groups: FacetGroup[]; total: number; revenue: number; revenueKnown: number; employees: number; truncated: boolean };
/** Derived data: no version bump or history. An estimate never replaces CRM revenue; a null trait is removed. */
export type AnnotateRecord = {
  /** The account, by id or by domain. */
  id?: string;
  domain?: string;
  revenue?: number | null;
  revenueSource?: "crm" | "estimate";
  revenueConfidence?: number;
  traits?: Record<string, string | null>;
};
export type AnnotateResponse = { updated: number; missing: string[] };

export type AccountsListResponse = { rows: AccountRow[]; nextCursor: string | null; total: number };

export const ContactsListRequest = z.object({
  filter: z.object({
    accountId: z.string().optional(), q: z.string().optional(),
    /** Service 1.29.0+ (CP14): only contacts the caller may see. */
    scope: z.object({ field: z.literal("ownerId"), owners: z.array(z.string()), unowned: z.boolean() }).optional(),
  }).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ContactsListRequest = z.infer<typeof ContactsListRequest>;
export type ContactsListResponse = { rows: ContactRow[]; nextCursor: string | null; total: number };

export const UpsertAccountsRequest = z.object({
  records: z.array(AccountInput),
  source: z.string(),
  idempotencyKey: z.string(),
  /** `missing`: only set fields that are empty on an existing row (service 1.5.0+; older services ignore it). */
  fill: z.enum(["all", "missing"]).optional(),
});
export type UpsertAccountsRequest = z.infer<typeof UpsertAccountsRequest>;

export const UpsertContactsRequest = z.object({
  records: z.array(ContactInput),
  source: z.string(),
  idempotencyKey: z.string(),
  /** `missing`: only set fields that are empty on an existing row (service 1.5.0+; older services ignore it). */
  fill: z.enum(["all", "missing"]).optional(),
});
export type UpsertContactsRequest = z.infer<typeof UpsertContactsRequest>;
/** `rejected`: the records that did not land, by index in the request (the service sends it; the fake may not). */
export type UpsertResponse = { upserted: number; ids: string[]; rejected?: Array<{ index: number; reason: string }> };

export const PatchValue = z.union([z.string(), z.number(), z.null()]);
export const EditRequest = z.object({
  object: z.enum(["account", "contact"]),
  id: z.string(),
  patch: z.record(z.string(), PatchValue),
  actorId: z.string(),
  idempotencyKey: z.string(),
  /** When the value changed at its source (epoch ms), stamped into fieldUpdatedAt. Not the edit's `at`. */
  sourceTimestamp: z.number().int().nonnegative().optional(),
  /** Service 1.8.0+: a digest of the whole operation when the patch is only part of it; the key is claimed for it. The patch may then be empty. */
  payload: z.string().optional(),
});
export type EditRequest = z.infer<typeof EditRequest>;
/**
 * `at`: the workspace's commit clock when the service applied the edit,
 * strictly increasing in the order edits were applied (service 1.6.0). A
 * replayed idempotency key answers with its first `version` and `at`; a key
 * reused for a different edit is an error. Absent from a service older than
 * 1.5.0 and from keys it stored before then.
 */
export type EditResponse = { version: number; at?: number };

/** What an edit applies (record and patch), compared when its idempotency key comes back. */
export function editRequestKey(req: Pick<EditRequest, "object" | "id" | "patch" | "payload">): string {
  return JSON.stringify([req.object, req.id, Object.entries(req.patch).sort(([a], [b]) => (a < b ? -1 : 1)), ...(req.payload ? [req.payload] : [])]);
}

export const reusedEditKeyMessage = (idempotencyKey: string) => `idempotency key ${idempotencyKey} was already used for a different request`;

export type GetResponse = { account: AccountRow; contacts: ContactRow[]; history: FieldHistoryRow[] };
/** `contacts/get` (service 1.5.0). */
export type GetContactResponse = { contact: ContactRow };

export const SharedSearchRequest = z.object({
  filter: AccountsFilter,
  limit: z.number().int().positive().max(5000),
});
export type SharedSearchRequest = z.infer<typeof SharedSearchRequest>;
/**
 * ICP fit weights (record service /rescore and prospect-search `rank`). Each
 * term is 0..100 points on the service side; the app works in 0..1 (fit / 100),
 * converted at the HTTP client boundary.
 */
export type IcpWeights = {
  base?: number;
  industries?: Record<string, number>;
  countries?: Record<string, number>;
  employeeBands?: Array<{ min: number; max: number; weight: number }>;
};

/**
 * Service 1.14.0+: one saved ICP as a gate (services/record-service contract.ts IcpGate).
 * Weights are points (0..100); fit inside the gate = 100 * (base + matched weights) / max.
 */
export type IcpGate = {
  id: string;
  base: number;
  max: number;
  industries: Record<string, number>;
  countries: Record<string, number>;
  employees: Array<{ min: number; max: number; weight: number }>;
  excludeIndustries: string[];
  excludeCountries: string[];
  /** `key` is "custom.<AI field slug>"; values are matched case-insensitively. */
  custom: Array<{ key: string; values?: string[]; min?: number; max?: number }>;
  /** Service 1.30.0+: who must work there (contract.ts IcpGate.buyer). All values lowercase. */
  buyer?: { levels: string[]; departments: string[]; topics: string[]; titles: string[]; exclude: string[] };
};
export type IcpStats = { gates: Array<{ id: string; members: number; unverified: number }> };

/** Service 1.31.0: a person criterion of an ICP tree (contract.ts TreePerson). Empty `levels` or `departments` mean any; all values lowercase. */
export type IcpTreePerson = { levels: string[]; departments: string[]; topics?: string[]; titles: string[]; exclude: string[] };
/** Service 1.31.0: company criteria of an ICP tree node, read as a gate's (contract.ts TreeAccount). */
export type IcpTreeAccount = {
  industries?: string[];
  countries?: string[];
  employees?: Array<{ min: number; max: number }>;
  excludeIndustries?: string[];
  excludeCountries?: string[];
  /** Service 1.40.0+: lowercase cities, owners (member ids, "__none__" for none) and annual revenue ranges in cents. */
  cities?: string[];
  owners?: string[];
  excludeOwners?: string[];
  revenue?: Array<{ min: number; max: number }>;
  custom?: IcpGate["custom"];
};
/** Service 1.31.0: one node of an ICP tree to count (contract.ts IcpTreeNode); a node names its parent before it. */
export type IcpTreeNode = { id: string; parent?: string; account?: IcpTreeAccount; has?: Array<{ neg?: boolean; person: IcpTreePerson }>; person?: IcpTreePerson };
type LegacyScopeBody = { field: "ownerId"; owners: string[]; unowned: boolean };
export type IcpTreeCountsRequest = { nodes: IcpTreeNode[]; accountScope?: LegacyScopeBody; contactScope?: LegacyScopeBody };
export type IcpTreeCounts = {
  nodes: Array<{ id: string; accounts: number; people: number }>;
  overlaps: Array<{ a: string; b: string; accounts: number }>;
};

/** `fit` (0..1) is present when the search was ranked. */
export type SharedSearchResponse = { rows: Array<AccountInput & { fit?: number }>; total: number };

/** One shared-index company with every column a CRM fill uses (service 1.46.0, POST /v1/shared/prospects/lookup). */
export type SharedCompanyDetail = {
  domain: string;
  name: string;
  industry?: string;
  country?: string;
  region?: string;
  locality?: string;
  linkedinUrl?: string;
  founded?: number;
  sizeBand?: string;
  employeesMin?: number;
  employeesMax?: number;
  domainConfidence: "high" | "low";
};

export type ChangeRow = {
  seq: number;
  object: "account" | "contact";
  id: string;
  op: string;
  fields: Record<string, unknown>;
  at: number;
};
export type ChangesResponse = { changes: ChangeRow[]; lastSeq: number };

/** Fields a user may edit through `records/edit`, per object. */
export const EDITABLE_ACCOUNT_FIELDS = ["name", "industry", "employees", "country", "linkedinUrl", "status", "ownerId"] as const;
// The record service's list (services/record-service/src/contract.ts EDITABLE_FIELDS): findEmail writes emailStatus.
export const EDITABLE_CONTACT_FIELDS = ["fullName", "title", "email", "emailStatus", "linkedinUrl", "phone", "status"] as const;
