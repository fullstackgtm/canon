// CanonCRM record service: HTTP contract.
//
// This file is the source of truth for the API. Clients (the Convex app) copy it
// verbatim, so it only imports zod and the import-free ./dimensions.ts.
//
// Every request carries `Authorization: Bearer <RECORD_SERVICE_TOKEN>`.
// Workspace routes also carry `X-Workspace-Id: <convex orgId>`, which must equal
// the `{ws}` path segment.
import { z } from "zod";
import { REGIONS, SIZE_BANDS, TRAIT_KEY_RE } from "./core/kernel/dimensions.ts";

export const CONTRACT_VERSION = "1.49.0"; // 1.49.0: import/{accounts,contacts,field_history} writes an archive's register rows, already remapped by Convex, into a workspace being imported, each replacing the row with its key; a linked row whose ledgerVersion is past a projected state keeps its columns, so replaying an imported ledger writes no history for states the row already holds. 1.48.0: export/{accounts,contacts,field_history} pages every stored row of a workspace's register in key order, and export/counts counts them, for workspace archives. 1.47.0: register account aggregates can group by stored fit. 1.46.1: prospects/lookup hash-joins the wanted domains (an IN list or per-domain index reads ran out of memory on the full index). 1.46.0: POST /v1/shared/prospects/lookup reads up to 1000 domains from the shared index with every column a CRM fill needs (location, founded year, size band, domain confidence). 1.45.0: private expiring research preparation and org-bound batched commit.  1.44.0: Activities aggregate unions independently scoped module docs before aggregation and echoes every source and projection stamp. 1.43.0: module projections carry package/generation and leased-key receipts, retained delete tombstones, fenced rebuild floors and complete-closure readiness. 1.42.0: bounded system-only inbound match read over the workspace register. 1.41.0: rescore atomically rejects lower or unversioned requests after a numbered configuration; equal versions are idempotent. 1.40.0: company criteria (ICP and territory trees, and the account list's `criteria`, every one of which must pass) take cities, owners (included or excluded, "__none__" for no owner) and annual revenue ranges. 1.39.0: territory-tree/counts answers the owner `moves` a tree implies: each company goes to the owner of the nearest node on its path that has one, a company whose owner would change is a move (or only unowned ones), listed up to `limit` with name, owners, node and version, and counted whole by from and to. 1.38.0: territory-tree/counts leaves companies named to the `cells` node out of its cells (they stay at the node; a carve can't move them) and answers how many (`pinnedToCellNode`). 1.37.0: territory-tree/counts counts a sales plan's territory tree (territoryTree.ts): siblings take accounts by first match in their `order`, accounts `named` to a node go there whatever the rules, and each node answers its accounts, ICP accounts and (with `owners`) who owns them; plus overlaps by rules before precedence, accounts in no top-level node, the leaf each of up to 5000 `assign` ids lands in, and one node's accounts by up to two dimensions (`cells`). Nothing is stored. 1.36.0: aggregates bucket a date by `year` too. 1.35.0: aggregates group by up to three keys (subtotals per every key but the last), and a sum, average, min or max may weight its field by another (`weight`: amount × probability, a fraction). 1.34.0: aggregates take up to five measures. 1.33.0: module reports (docs/modules.md, "Reports and charts"): modules/{module}/sync keeps a module's projected docs (module_docs, moduleDocs.ts) as Canon writes them, and modules/{module}/aggregate answers a report over one collection's docs, admitting only the docs its scope names (an owner list, a row condition through related docs, and a set's live generation under a parent the caller reads). 1.32.0: aggregates bucket a date by `day` too (reports pacing: a running total by day of the period). 1.31.0: icp-tree/counts counts an ICP as a tree (docs/icp-tree.md): ICPs, segments (narrower accounts, which may require that someone like a person criterion works there, or that no one does) and personas (people matching a person criterion at their parent's accounts), each node's accounts and people, and the accounts each pair of sibling nodes shares. Nothing is stored. 1.30.0: an ICP gate may carry a `buyer`: an account is in the ICP only when one of its live contacts's title matches it (titles.ts levels and departments in SQL), contact writes refit their accounts, and icp-stats counts accounts that fit but have no buyer as unverified. 1.29.0: record visibility (CP14): p/<object>/list, register/{account,contact}/list and both aggregates take a `scope` {field, owners, unowned}, and p/search takes `scopes` by object: only records whose owner field is one of `owners`, or empty when `unowned`, are listed, found or counted (field `id` names the records themselves, up to 5000); a cursor is bound to its scope; register duplicates take a `scope` over ownerId and match only inside it. Convex derives the scope from the caller's role. 1.28.0: 1.28.0: a person has several emails and phones (#299): contacts carry `additionalEmails` and `additionalPhones` registry lists (VARCHAR[], written back by the projector; a row from before has none), a contact list's `email` filter (eq, neq, in, contains, startsWith) and search match any of a person's emails, duplicates link people who share any email, and a contacts upsert finds a person by one of their other emails. 1.27.0: reports (CP9): POST p/<object>/aggregate and register/{account,contact}/aggregate group an object's live records, filtered as its list is, by up to two keys (a field, a date bucketed by week, month or quarter, or a field of the record a lookup points at) and answer count, sum, average, min and max per group, per first key and in total. 1.26.0: formula and rollup fields (CP7c): list rows of p_<object> and the register carry each live formula or rollup field, computed by the list query from the projection (computed.ts), so they filter and sort like stored columns; nothing is stored, so no migration. 1.25.0: contacts carry a `leadStatus` registry field (CP6), listed, filtered and written back like `lifecycleStage`. 1.24.0: register/{account,contact}/duplicates (CP15b): candidate groups over the live register, strongest first, each with why its records match. 1.23.0: merges (CP15a): a register row merged into another on the ledger carries `mergedInto` (its survivor's stream), is left out of the recycle bin, and a value a merge picked, or a contact's company a merge moved, goes to the outbox as op `merge`, which the Salesforce sync never pushes. 1.22.0: register lists carry, filter and sort on the workspace's custom fields (CP7a field builder), read from the row's `custom` JSON by apiName with the definition the projector stored; archived fields are left out; emails, phones and links field types project as ordered VARCHAR[]. 1.21.0: accounts facet on `field:<slug>` (an AI field's accepted answer in `custom`, "__none__" when not answered) and filter on `custom` {slug: answers}. 1.20.0: associations (CP3): the projector keeps edge streams in p_association and writes a contact's accountId from its primary contact-to-company edge; such a contact is marked `accountLedger`, and upserts and domain linking leave its accountId alone. 1.19.0: POST /v1/shared/prospects/facets groups the shared index by industry, country, region or size band (market sizes), and prospect filters take `sizeBand` and `region`. 1.18.0: records/edit takes a contact's `phone` (the dialer, docs/dialer.md). 1.17.0: canonical industries (industries.ts): industry filters, facets, ICP gates and fit match accounts on one canonical industry whatever spelling a source wrote (PDL and HubSpot names, Leadsforge, QuickEnrich, common CRM values); facet keys are canonical, and a value no table maps groups as "~<value>". 1.16.0: a contact with no account (one from the ledger) is linked to the account its email's domain names, never a personal domain, when it is written and when that account first takes the domain; existing ones are backfilled once. An explicit accountId always wins. 1.15.0: 1.15.0: register/contact/list rows carry, filter and sort on `accountFit` and `accountIcpIds`, read from the contact's account; register/account/list does the same for `icpIds`. 1.14.0: rescore takes `gates`, one per saved ICP: an account is in an ICP only when it passes every criterion (unknown values fail), `fit` is its best score inside the ICPs it passes (0 outside them), and rows carry `icpIds`; lists filter on `icpId`; icp-stats counts members and unverified accounts. 1.13.0: register/contact/list matches `email` eq, neq and in filters whatever the case. 1.12.0: register/contact/list rows carry the contact's `accountId`. 1.11.0: p/search reads accounts and contacts from the register (record ids, worked or not, matched on domain and email too), bounds hits per object with `perObject`, and returns a `detail` per hit for accounts, contacts and deals. 1.10.0: rescore takes and stores the ICP `version` of its weights. 1.9.0: register/{account,contact}/list, the generic list request over the register. 1.8.0: one register of accounts and contacts: rows linked to a ledger stream (`stream`, `ledgerVersion`) take their registry fields from the projector's write-back; upserts leave those fields alone and records/edit refuses them (409); lists skip rows deleted on the ledger. 1.5.0: `fill: "missing"` upserts, `nameIfCurrently`, contacts matched across LinkedIn and name-only sources. 1.6.0: contacts/get; records/edit returns a commit-ordered `at` and refuses a reused idempotency key with a different patch (409).

/** Workspace ids become file names, so they are restricted to a safe alphabet. */
export const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WorkspaceId = z.string().regex(WORKSPACE_ID_RE);

export const AccountStatus = z.enum(["new", "working", "qualified", "disqualified"]);
export type AccountStatus = z.infer<typeof AccountStatus>;
export const ContactStatus = z.enum(["new", "working", "qualified", "disqualified"]);
export type ContactStatus = z.infer<typeof ContactStatus>;

const str = (max = 512) => z.string().trim().min(1).max(max);
const optStr = (max = 512) => z.string().trim().max(max).optional();

// ---------- Salesforce ids ----------

const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const SF_SUFFIX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
/** Normalize a 15- or 18-character Salesforce id to its 18-character form. Returns null if invalid. */
export function normalizeSfId(id: string): string | null {
  const s = id.trim();
  if (!SF_ID_RE.test(s)) return null;
  const base = s.slice(0, 15);
  let suffix = "";
  for (let block = 0; block < 3; block++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const ch = base[block * 5 + i];
      if (ch >= "A" && ch <= "Z") bits |= 1 << i;
    }
    suffix += SF_SUFFIX[bits];
  }
  // An 18-char id must carry the right checksum (case-insensitively, as Salesforce does).
  if (s.length === 18 && s.slice(15).toUpperCase() !== suffix) return null;
  return base + suffix;
}
/** A Salesforce id (15 or 18 chars), normalized to 18 chars. */
export const SfId = z.string().trim().transform((v, ctx) => {
  const n = normalizeSfId(v);
  if (!n) {
    ctx.addIssue({ code: "custom", message: "invalid Salesforce id" });
    return z.NEVER;
  }
  return n;
});

/**
 * Object API names for metadata-driven objects (custom objects, and standard
 * objects with no typed table such as Opportunity or Lead).
 */
export const OBJECT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export const ObjectName = z.string().regex(OBJECT_NAME_RE);

// ---------- inputs ----------

/** Accounts are keyed by normalized domain: re-upserting a domain updates it. */
export const AccountInput = z.object({
  sfId: SfId.optional(),
  domain: str(253),
  name: str(),
  /**
   * 1.5.0, upsert only: replace an existing row's name only while it still
   * equals this value (a generated placeholder), so a better name never
   * overwrites one a rep or a CRM wrote. Not stored.
   */
  nameIfCurrently: optStr().optional(),
  industry: optStr(),
  employees: z.number().int().min(0).max(10_000_000).optional(),
  country: optStr(128),
  linkedinUrl: optStr(),
  status: AccountStatus.optional(),
  ownerId: optStr(128),
  segmentIds: z.array(str(128)).max(64).optional(),
});
export type AccountInput = z.infer<typeof AccountInput>;

/**
 * Contacts belong to an account, named by `accountId` or `accountDomain`
 * (the account must already exist). Identity: email if present, else
 * linkedinUrl, else account + fullName.
 */
export const ContactInput = z
  .object({
    sfId: SfId.optional(),
    accountId: optStr(64),
    accountDomain: optStr(253),
    /** Names the account by its Salesforce id (the account must already carry that sfId). */
    accountSfId: SfId.optional(),
    fullName: str(),
    title: optStr(),
    email: optStr(320),
    emailStatus: optStr(32),
    linkedinUrl: optStr(),
    status: ContactStatus.optional(),
  })
  .refine((c) => c.accountId || c.accountDomain || c.accountSfId, { message: "accountId, accountDomain or accountSfId is required" });
export type ContactInput = z.infer<typeof ContactInput>;

/**
 * Merge hints. Each incoming record is matched to an existing row by the keys
 * in `matchBy`, in order; the first key that finds a row wins. Without
 * `merge`, matching is sfId first, then the natural key (domain for accounts;
 * email, then linkedinUrl, for contacts). A record that would collide with a
 * row it may not match is rejected with a reason instead of failing the batch.
 */
export const MergeHints = z.object({
  matchBy: z.array(z.enum(["sfId", "domain", "email", "linkedinUrl"])).min(1).max(4),
});
export type MergeHints = z.infer<typeof MergeHints>;

/**
 * `missing`: on a row that already exists, set only fields that are empty, so
 * a bulk source (CRM population) never overwrites a value a rep or a better
 * source wrote. Default `all` sets every field sent.
 */
export const FillMode = z.enum(["all", "missing"]);
export const UpsertAccountsBody = z.object({
  records: z.array(AccountInput).min(1).max(5000),
  source: str(64),
  idempotencyKey: str(200),
  merge: MergeHints.optional(),
  fill: FillMode.optional(),
});
export type UpsertAccountsBody = z.infer<typeof UpsertAccountsBody>;
export const UpsertContactsBody = z.object({
  records: z.array(ContactInput).min(1).max(5000),
  source: str(64),
  idempotencyKey: str(200),
  merge: MergeHints.optional(),
  fill: FillMode.optional(),
});
export type UpsertContactsBody = z.infer<typeof UpsertContactsBody>;
/** Anonymous research is prepared outside the workspace register. Only the backend bearer can prepare or claim it. */
export const PrepareResearchBody = z.object({
  sessionId: WorkspaceId,
  expiresAt: z.number().int().positive(),
  records: z.array(AccountInput).max(5000),
  source: str(64),
}).strict();
export type PrepareResearchBody = z.infer<typeof PrepareResearchBody>;
export const CommitResearchBody = z.object({ sessionId: WorkspaceId }).strict();
export type ResearchCommitResult = { importedAccounts: number; total: number; done: boolean };

/**
 * `upserted` = ids.length = distinct rows the batch landed on (new or existing,
 * changed or not). `created` = new rows. `merged` = records with an sfId that
 * attached to an existing row that had none (TAM dedupe). `rejected` = records
 * that did not land, with their index in the request and a reason.
 */
export const UpsertResult = z.object({
  upserted: z.number(),
  ids: z.array(z.string()),
  created: z.number(),
  merged: z.number(),
  rejected: z.array(z.object({ index: z.number(), sfId: z.string().optional(), reason: z.string() })),
});
export type UpsertResult = z.infer<typeof UpsertResult>;

/** An AI field's slug (Convex researchAgents.slug); safe inside a quoted JSON path. */
export const FIELD_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Record visibility (CP14, 1.29.0): the owners whose records a request may return; empty owners with `unowned: false` returns none. */
export const OwnerScopeBody = z.object({
  field: z.string().min(1).max(128),
  owners: z.array(z.string().min(1).max(512)).max(5000),
  unowned: z.boolean(),
}).strict();
/** The legacy account and contact lists read the owner from `ownerId`, the only owner column they have. */
const LegacyScope = OwnerScopeBody.refine((s) => s.field === "ownerId", "scope field must be ownerId");

export const AccountFilter = z.object({
  segmentId: optStr(128),
  status: AccountStatus.optional(),
  ownerId: optStr(128),
  minFit: z.number().min(0).max(100).optional(),
  q: optStr(200),
  /** Exact Salesforce id match (15 or 18 chars; normalized to 18). Added in 1.2.1. */
  sfId: SfId.optional(),
  industry: z.array(str()).max(100).optional(),
  country: z.array(str(128)).max(250).optional(),
  employeeMin: z.number().int().min(0).optional(),
  employeeMax: z.number().int().min(0).optional(),
  // 1.4.0 (TAM explorer). Each list also accepts "__none__" (dimensions.ts NONE),
  // which matches accounts with no value; so do `industry`, `country` and `segmentId`.
  /** Employee size band keys (dimensions.ts SIZE_BANDS). */
  sizeBand: z.array(z.enum([...SIZE_BANDS.map((b) => b.key), "__none__"])).max(20).optional(),
  /** Region keys derived from country (dimensions.ts REGIONS). */
  region: z.array(z.enum([...REGIONS.map((r) => r.key), "__none__"])).max(20).optional(),
  /** Trait key -> accepted values (any of). Every listed trait must match. */
  traits: z.record(z.string().regex(TRAIT_KEY_RE), z.array(str(64)).min(1).max(50)).optional(),
  /** 1.14.0: accounts inside this ICP gate (RescoreBody.gates). */
  icpId: optStr(64),
  /** 1.21.0: AI-field slug -> accepted answers (any of, case-insensitive; "__none__" = not answered). */
  custom: z.record(z.string().regex(FIELD_SLUG_RE), z.array(str(200)).min(1).max(50)).optional(),
  /** 1.29.0 (CP14): only accounts the caller may see. */
  scope: LegacyScope.optional(),
  /** 1.40.0: company criteria as a tree node's (query lines: a territory and the lines above it), every one of which must pass. */
  criteria: z.array(z.lazy(() => TerritoryAccount)).max(8).optional(),
});
export type AccountFilter = z.infer<typeof AccountFilter>;

export const AccountSort = z.object({
  field: z.enum(["fit", "name", "employees", "updatedAt"]),
  dir: z.enum(["asc", "desc"]),
});
export type AccountSort = z.infer<typeof AccountSort>;

export const ListAccountsBody = z.object({
  filter: AccountFilter.optional(),
  sort: AccountSort.optional(), // default: fit desc
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(), // default 50
});
export type ListAccountsBody = z.infer<typeof ListAccountsBody>;

export const ListContactsBody = z.object({
  filter: z.object({ accountId: optStr(64), q: optStr(200), sfId: SfId.optional(), scope: LegacyScope.optional() }).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(), // default 50
});
export type ListContactsBody = z.infer<typeof ListContactsBody>;

export const GetAccountBody = z.object({ id: str(64) });
export type GetAccountBody = z.infer<typeof GetAccountBody>;
/** One contact by id (1.5.0). */
export const GetContactBody = z.object({ id: str(64) });
export type GetContactBody = z.infer<typeof GetContactBody>;

/** Editable fields per object. Other keys are rejected with 400. */
export const EDITABLE_FIELDS = {
  account: ["name", "industry", "employees", "country", "linkedinUrl", "status", "ownerId"],
  contact: ["fullName", "title", "email", "emailStatus", "linkedinUrl", "phone", "status"],
} as const;

export const EditBody = z
  .object({
    object: z.enum(["account", "contact"]),
    id: str(64),
    patch: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.null()])),
    actorId: str(128),
    idempotencyKey: str(200),
    /** Origin of the write, recorded on the outbox row (default "fsgtm"). Inbound sync passes "salesforce". */
    source: optStr(64),
    /** When the value changed at the source (epoch ms). Stamped into fieldUpdatedAt; default now. */
    sourceTimestamp: z.number().int().min(0).optional(),
    /** Optimistic concurrency: 409 if the row's version differs. */
    expectedVersion: z.number().int().min(1).optional(),
    /**
     * 1.8.0: a digest of the whole operation when the patch is only part of it (Convex writes the rest to the
     * ledger). The key is claimed for this digest: reusing it for a different operation is a 409. With a
     * payload the patch may be empty: the call only claims the key and checks the record exists.
     */
    payload: z.string().min(1).max(128).optional(),
  })
  .superRefine((b, ctx) => {
    const allowed = EDITABLE_FIELDS[b.object] as readonly string[];
    const keys = Object.keys(b.patch);
    if (!keys.length && !b.payload) ctx.addIssue({ code: "custom", message: "patch is empty", path: ["patch"] });
    for (const k of keys) if (!allowed.includes(k)) ctx.addIssue({ code: "custom", message: `field ${k} is not editable on ${b.object}`, path: ["patch", k] });
    if ("status" in b.patch && !AccountStatus.safeParse(b.patch.status).success)
      ctx.addIssue({ code: "custom", message: "invalid status", path: ["patch", "status"] });
    if ("employees" in b.patch && b.patch.employees !== null && (typeof b.patch.employees !== "number" || !Number.isInteger(b.patch.employees)))
      ctx.addIssue({ code: "custom", message: "employees must be an integer or null", path: ["patch", "employees"] });
    for (const req of ["name", "fullName"]) if (req in b.patch && (b.patch[req] === null || b.patch[req] === ""))
      ctx.addIssue({ code: "custom", message: `${req} cannot be cleared`, path: ["patch", req] });
  });
export type EditBody = z.infer<typeof EditBody>;
/**
 * `at` (1.5.0; 1.6.0 semantics): the workspace's commit clock when the edit
 * was applied, strictly increasing in the order edits commit, so it orders
 * edits exactly as the service did. `sourceTimestamp` only stamps
 * fieldUpdatedAt. A replayed idempotency key answers with its first `version`
 * and `at`; since 1.6.0 a key reused for a different object, id or patch is a
 * 409 and applies nothing.
 */
export const EditResult = z.object({ version: z.number(), at: z.number() });
export type EditResult = z.infer<typeof EditResult>;

export const SegmentCountBody = z.object({ filter: AccountFilter });
export type SegmentCountBody = z.infer<typeof SegmentCountBody>;

/**
 * Group accounts by one dimension (1.4.0). `trait:<key>` groups by a trait's
 * value; `segment` unnests segmentIds, so an account in several segments
 * counts in each. Missing values group under "__none__".
 */
export const FacetDimension = z.union([
  z.enum(["industry", "sizeBand", "region", "country", "segment"]),
  z.string().regex(new RegExp(`^trait:${TRAIT_KEY_RE.source.slice(1, -1)}$`)),
  /** 1.21.0: an AI field's accepted answer (accounts.custom["custom.<slug>"]), "__none__" when not answered. */
  z.string().regex(new RegExp(`^field:${FIELD_SLUG_RE.source.slice(1, -1)}$`)),
]);
export type FacetDimension = z.infer<typeof FacetDimension>;
export const FacetsBody = z.object({
  filter: AccountFilter.optional(),
  groupBy: FacetDimension,
  /** Largest groups by count (default 200). The totals cover every group. */
  limit: z.number().int().min(1).max(1000).optional(),
});
export type FacetsBody = z.infer<typeof FacetsBody>;

/**
 * Derived account data (1.4.0): revenue and traits (e.g. Jev segment answers).
 * Not a user edit: no version bump, field history or outbox row, so it never
 * conflicts with edits or echoes to a CRM. `revenue: null` clears it. An
 * "estimate" never replaces "crm" revenue. A trait set to null is removed.
 */
export const RevenueSource = z.enum(["crm", "estimate"]);
export const AnnotateAccountsBody = z.object({
  records: z
    .array(
      z.object({
        /** The account, by id or by domain (normalized as on upsert). */
        id: str(64).optional(),
        domain: str(253).optional(),
        revenue: z.number().min(0).max(1e13).nullable().optional(),
        revenueSource: RevenueSource.optional(),
        /** 0..1, for estimates. */
        revenueConfidence: z.number().min(0).max(1).optional(),
        traits: z.record(z.string().regex(TRAIT_KEY_RE), str(64).nullable()).optional(),
      }).refine((r) => r.id || r.domain, { message: "id or domain is required" }),
    )
    .min(1)
    .max(2000),
});
export type AnnotateAccountsBody = z.infer<typeof AnnotateAccountsBody>;

/**
 * ICP weights. fit = clamp(0, 100, base + industry weight + country weight + the
 * weight of every employee band the account falls in). Keys match case-insensitively.
 */
export const IcpWeights = z.object({
  base: z.number().min(-100).max(100).optional(),
  industries: z.record(z.string(), z.number().min(-100).max(100)).optional(),
  countries: z.record(z.string(), z.number().min(-100).max(100)).optional(),
  employeeBands: z
    .array(z.object({ min: z.number().int().min(0), max: z.number().int().min(0), weight: z.number().min(-100).max(100) }))
    .max(50)
    .optional(),
});
export type IcpWeights = z.infer<typeof IcpWeights>;
/** An accepted AI-field answer (accounts.custom) an ICP requires: one of `values` (case-insensitive), or a number in [min, max]. */
export const IcpCustomCriterion = z
  .object({
    key: z.string().regex(/^custom\.[A-Za-z0-9_-]{1,64}$/),
    values: z.array(str(200)).min(1).max(50).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((c) => c.values || c.min !== undefined || c.max !== undefined, { message: "a criterion needs values, min or max" });
const weightRecord = z.record(z.string(), z.number().min(0).max(100));
/**
 * 1.14.0: one saved ICP as a gate. An account passes when its industry, country
 * and employees are in the include sets (an empty set allows any value, a
 * non-empty one fails an unknown value), none is excluded, and every custom
 * criterion matches. Inside the gate, fit = 100 * (base + the weights it
 * matches) / max, so a perfect match scores 100.
 */
export const IcpGate = z.object({
  id: str(64),
  base: z.number().min(0).max(100),
  max: z.number().positive().max(400),
  industries: weightRecord,
  countries: weightRecord,
  employees: z.array(z.object({ min: z.number().int().min(0), max: z.number().int().min(0), weight: z.number().min(0).max(100) })).max(20),
  excludeIndustries: z.array(str()).max(100),
  excludeCountries: z.array(str(128)).max(250),
  custom: z.array(IcpCustomCriterion).max(20),
  /**
   * 1.30.0: who must work there. With `buyer`, an account passes only when one of its live
   * contacts is a buyer: their lowercased title contains none of `exclude`, and either
   * contains one of `titles`, or their level (titles.ts) is one of `levels` and, when
   * `departments` or `topics` are given, their department is one of `departments` or
   * their title contains one of `topics`. All values lowercase.
   */
  buyer: z.object({
    levels: z.array(str(32)).max(20),
    departments: z.array(str(64)).max(20),
    topics: z.array(str(128)).max(50),
    titles: z.array(str(128)).max(50),
    exclude: z.array(str(128)).max(50),
  }).optional(),
});
export type IcpGate = z.infer<typeof IcpGate>;
/**
 * 1.10.0: `version`, the Convex ICP version these weights are (docs/signal-ledger.md, SL4).
 * 1.14.0: `gates` replace the weights for fit (the weights stay stored for older readers).
 */
export const RescoreBody = z.object({ icp: IcpWeights, version: z.number().int().min(1).optional(), gates: z.array(IcpGate).max(25).optional() });
export type RescoreBody = z.infer<typeof RescoreBody>;

/**
 * 1.31.0: a person criterion of an ICP tree. Someone matches when their lowercased title contains none of
 * `exclude`, and either contains one of `titles`, or their level (titles.ts) is one of `levels` (any level when
 * empty) and their department is one of `departments` or their title contains one of `topics` (any, when both
 * are empty). With only `titles`, only titles match. A gate's buyer reads the same, except that its empty
 * `levels` admit no level.
 */
const TreePerson = z.object({
  levels: z.array(str(32)).max(20),
  departments: z.array(str(64)).max(20),
  topics: z.array(str(128)).max(50).optional(),
  titles: z.array(str(128)).max(50),
  exclude: z.array(str(128)).max(50),
});
/** 1.31.0: company criteria of an ICP tree node, read as a gate's: an empty set allows any value, a non-empty one fails an unknown value. */
const TreeAccount = z.object({
  industries: z.array(str()).max(100).optional(),
  countries: z.array(str(128)).max(250).optional(),
  employees: z.array(z.object({ min: z.number().int().min(0), max: z.number().int().min(0) })).max(20).optional(),
  excludeIndustries: z.array(str()).max(100).optional(),
  excludeCountries: z.array(str(128)).max(250).optional(),
  /** 1.40.0: lowercase cities; owners' member ids ("__none__": no owner), included or excluded; annual revenue ranges in cents. */
  cities: z.array(str(128)).max(60).optional(),
  owners: z.array(str(128)).max(60).optional(),
  excludeOwners: z.array(str(128)).max(60).optional(),
  revenue: z.array(z.object({ min: z.number().min(0), max: z.number().min(0) })).max(20).optional(),
  custom: z.array(IcpCustomCriterion).max(20).optional(),
});
/**
 * 1.31.0: one node of an ICP tree. An account node (no `person`) holds its parent's accounts (all live accounts
 * for a root) that pass `account` and every `has` (someone there matches; with `neg`, no one does). A person node
 * holds the people at its parent's accounts who match `person`; its accounts are the ones with at least one. A
 * node names its parent before it, and a person node has no children.
 */
export const IcpTreeNode = z.object({
  id: str(64),
  parent: str(64).optional(),
  account: TreeAccount.optional(),
  has: z.array(z.object({ neg: z.boolean().optional(), person: TreePerson })).max(5).optional(),
  person: TreePerson.optional(),
}).refine((n) => !n.person || (!n.account && !n.has?.length), { message: "a person node takes no account criteria" });
export type IcpTreeNode = z.infer<typeof IcpTreeNode>;
export const IcpTreeCountsBody = z.object({
  nodes: z.array(IcpTreeNode).min(1).max(100),
  /** The accounts and contacts a caller sees (1.29.0 scopes); people are counted at the accounts in scope. */
  accountScope: LegacyScope.optional(),
  contactScope: LegacyScope.optional(),
}).strict().superRefine((b, ctx) => {
  const seen = new Map<string, boolean>();
  for (const n of b.nodes) {
    if (seen.has(n.id)) ctx.addIssue({ code: "custom", message: `node ${n.id} appears twice` });
    if (n.parent !== undefined && !seen.has(n.parent)) ctx.addIssue({ code: "custom", message: `node ${n.id} names a parent not before it` });
    if (n.parent !== undefined && seen.get(n.parent)) ctx.addIssue({ code: "custom", message: `node ${n.id}'s parent is a person node` });
    seen.set(n.id, Boolean(n.person));
  }
});
export type IcpTreeCountsBody = z.infer<typeof IcpTreeCountsBody>;
/** 1.37.0: a territory tree (territoryTree.ts): company criteria (no AI fields or people), precedence and named accounts. */
const TerritoryAccount = TreeAccount.omit({ custom: true });
export const TerritoryTreeBody = z.object({
  nodes: z.array(z.object({ id: str(64), parent: str(64).optional(), order: z.number().optional(), account: TerritoryAccount.optional(), named: z.array(str(128)).max(2000).optional() }).strict()).min(1).max(200),
  accountScope: LegacyScope.optional(),
  owners: z.boolean().optional(),
  assign: z.array(str(128)).max(5000).optional(),
  assignDomains: z.array(str(253)).max(5000).optional(),
  cells: z.object({ node: str(64), by: z.array(z.enum(["country", "region", "sizeBand", "industry"])).min(1).max(2) }).strict().optional(),
  moves: z.object({ owners: z.record(str(64), str(128)), scope: z.enum(["all", "unowned"]), limit: z.number().int().min(1).max(5000) }).strict().optional(),
}).strict();
export type TerritoryTreeBody = z.infer<typeof TerritoryTreeBody>;
/** Per node: its accounts and, for a person node, its people. Per pair of nodes with the same parent: the accounts both hold. */
export type IcpTreeCountsResult = {
  nodes: Array<{ id: string; accounts: number; people: number }>;
  overlaps: Array<{ a: string; b: string; accounts: number }>;
};

// ---------- metadata-driven objects ----------

export const FieldType = z.enum(["string", "number", "boolean", "date", "datetime", "picklist", "reference", "json"]);
export type FieldType = z.infer<typeof FieldType>;
export const ObjectDef = z.object({
  name: ObjectName,
  label: str(255),
  fields: z
    .array(z.object({ name: ObjectName, type: FieldType, referenceTo: z.array(str(80)).max(50).optional() }))
    .max(1000),
});
export type ObjectDef = z.infer<typeof ObjectDef>;
export const DefineObjectsBody = z.object({ objects: z.array(ObjectDef).min(1).max(2000) });
export type DefineObjectsBody = z.infer<typeof DefineObjectsBody>;

/**
 * A record of a defined object. Identity: sfId, else externalKey; with
 * neither, every upsert creates a new row. `fields` keys must be defined on
 * the object; values are coerced to the field type (CSV strings are accepted).
 */
export const CustomRecordInput = z.object({
  sfId: SfId.optional(),
  externalKey: optStr(255),
  fields: z.record(z.string(), z.unknown()),
});
export type CustomRecordInput = z.infer<typeof CustomRecordInput>;
export const UpsertObjectsBody = z.object({
  records: z.array(CustomRecordInput).min(1).max(5000),
  source: str(64),
  idempotencyKey: str(200),
});
export type UpsertObjectsBody = z.infer<typeof UpsertObjectsBody>;
export const ListObjectsBody = z.object({
  filter: z.object({ q: optStr(200), sfId: SfId.optional(), updatedAfter: z.number().int().min(0).optional() }).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(200).optional(), // default 50
});
export type ListObjectsBody = z.infer<typeof ListObjectsBody>;
export const GetObjectBody = z.object({ id: str(80) });
export const EditObjectBody = z.object({
  id: str(80),
  fields: z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length > 0, "fields is empty"),
  expectedVersion: z.number().int().min(1).optional(),
  actor: str(128),
  source: str(64),
  sourceTimestamp: z.number().int().min(0).optional(),
  idempotencyKey: optStr(200),
});
export type EditObjectBody = z.infer<typeof EditObjectBody>;
export const HistoryBody = z.object({ object: ObjectName, id: str(80) });
export type HistoryBody = z.infer<typeof HistoryBody>;

/** 1.48.0: one page of a workspace's register for its archive. `after` is the previous page's `next`. */
export const ExportPageBody = z.object({ after: z.string().max(200).optional(), limit: z.number().int().min(1).max(2000).default(500) }).strict();
export type ExportPageBody = z.infer<typeof ExportPageBody>;
/** At most 1000 rows of one register table, every column as an export page carries it. */
export const ImportPageBody = z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(1000) }).strict();
export type ImportPageBody = z.infer<typeof ImportPageBody>;
export type ExportPageResponse = { rows: Record<string, unknown>[]; next: string | null };
export type ExportCountsResponse = { accounts: number; contacts: number; field_history: number };

export const ChangesQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

/** 1.19.0: `sizeBand` and `region` (dimensions.ts keys, as in workspace filters) also narrow the shared index. */
const ProspectFilter = AccountFilter.pick({ q: true, industry: true, country: true, employeeMin: true, employeeMax: true, sizeBand: true, region: true });
export const ProspectSearchBody = z.object({
  filter: ProspectFilter
    .extend({
      /**
       * Business types ("group/archetype", services/prospect-index taxonomy) from
       * the index's company_tags. Added in 1.3.0; 422 when the loaded index has no tags.
       */
      archetype: z.array(str(128)).min(1).max(20).optional(),
      /** Minimum tag confidence for `archetype` (default 0.15: below it the tag is a guess). */
      minArchetypeP: z.number().min(0).max(1).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
  /**
   * Rank by ICP fit (same weights and 0..100 scale as POST /rescore), so the
   * best matches come back first out of the whole index rather than the first
   * `limit` rows. Rows then carry `fit`.
   */
  rank: IcpWeights.optional(),
});
export type ProspectSearchBody = z.infer<typeof ProspectSearchBody>;

/**
 * 1.19.0: the shared index grouped by one dimension, for market sizes (docs/tam-and-icps.md). Keys match
 * workspace facets: canonical industries, lowercase countries, dimensions.ts regions and size bands.
 */
export const ProspectFacetsBody = z.object({
  filter: ProspectFilter.omit({ q: true }).optional(),
  groupBy: z.enum(["industry", "country", "region", "sizeBand"]),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type ProspectFacetsBody = z.infer<typeof ProspectFacetsBody>;
export type ProspectFacetsResult = { groups: Array<{ key: string; count: number }>; total: number; truncated: boolean };

/** 1.46.0: the shared index's row for each of these domains (normalized like the index), for filling a connected CRM's blanks. */
export const ProspectLookupBody = z.object({ domains: z.array(str(253)).min(1).max(1000) });
export type ProspectLookupBody = z.infer<typeof ProspectLookupBody>;
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
export type ProspectLookupResult = { rows: SharedCompanyDetail[] };

// ---------- outputs ----------

export type AccountRow = {
  id: string;
  sfId?: string;
  domain: string;
  name: string;
  industry?: string;
  employees?: number;
  country?: string;
  linkedinUrl?: string;
  fit: number;
  status: AccountStatus;
  ownerId?: string;
  segmentIds: string[];
  source: string;
  updatedAt: number; // epoch ms
  version: number;
  /** Per-field last-change time (epoch ms), for sync conflict resolution. */
  fieldUpdatedAt: Record<string, number>;
  /** 1.4.0: annual revenue (USD) and where it came from. */
  revenue?: number;
  revenueSource?: "crm" | "estimate";
  revenueConfidence?: number;
  /** 1.4.0: derived traits (trait key -> value). */
  traits: Record<string, string>;
  /** 1.14.0: the ICP gates this account passes. */
  icpIds: string[];
  /** 1.8.0: the ledger stream this row is linked to, and the stream version last written back. */
  stream?: string;
  ledgerVersion?: number;
  phone?: string;
  city?: string;
  description?: string;
  /** 1.8.0: the ledger's annual revenue, in cents like every money field in Canon. */
  annualRevenue?: number;
};

export type ContactRow = {
  id: string;
  sfId?: string;
  accountId: string;
  fullName: string;
  title?: string;
  email?: string;
  emailStatus?: string;
  linkedinUrl?: string;
  status: ContactStatus;
  source: string;
  updatedAt: number;
  version: number;
  fieldUpdatedAt: Record<string, number>;
  /** 1.8.0: see AccountRow. */
  stream?: string;
  ledgerVersion?: number;
  phone?: string;
  ownerId?: string;
  lifecycleStage?: string;
  leadStatus?: string;
};

export type CustomRecordRow = {
  id: string;
  object: string;
  sfId?: string;
  externalKey?: string;
  fields: Record<string, unknown>;
  fieldUpdatedAt: Record<string, number>;
  source: string;
  updatedAt: number;
  version: number;
};

export type FieldHistoryRow = {
  seq: number;
  object: string; // "account" | "contact" | a defined object name
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actorId: string;
  /** Write origin ("fsgtm", "salesforce", ...); absent on rows written before 1.2.0. */
  source?: string;
  at: number;
};

export type ListAccountsResult = { rows: AccountRow[]; nextCursor: string | null; total: number };
export type ListContactsResult = { rows: ContactRow[]; nextCursor: string | null; total: number };
export type GetAccountResult = { account: AccountRow; contacts: ContactRow[]; history: FieldHistoryRow[] };
export type GetContactResult = { contact: ContactRow };
export type SegmentCountResult = { total: number };
/** `revenue` sums known revenue; `revenueKnown` counts accounts that have it. */
/** `employees`: sum of known employee counts (sizes the treemap's opportunity metric). */
export type FacetGroup = { key: string; count: number; revenue: number; revenueKnown: number; employees: number };
export type FacetsResult = { groups: FacetGroup[]; total: number; revenue: number; revenueKnown: number; employees: number; truncated: boolean };
/** `missing`: the id (or domain) of each record that matched no account. */
export type AnnotateResult = { updated: number; missing: string[] };
export type RescoreResult = { rescored: number; ms: number };
/** 1.14.0: per ICP gate, the accounts inside it and those that fail only on unknown values. */
export type IcpStatsResult = { gates: Array<{ id: string; members: number; unverified: number }> };
export type ProvisionResult = { created: boolean };
export type DefineObjectsResult = { defined: number };
export type ListObjectsResult = { rows: CustomRecordRow[]; total: number; nextCursor?: string };
export type GetObjectResult = { record: CustomRecordRow };
export type HistoryResult = { rows: FieldHistoryRow[] };
/**
 * Outbox row. `seq` is strictly increasing and never reused, across restarts
 * and crashes; gaps are allowed. `fields` names the fields that changed and
 * `values` carries their new values. `origin` is the write's source (upsert
 * `source`, or edit `source`, default "fsgtm"), so a sync consumer can skip
 * its own echoes.
 */
export type Change = {
  seq: number;
  object: string; // "account" | "contact" | "workspace" | a defined object name
  id: string;
  op: "upsert" | "edit" | "delete" | "rescore";
  fields: string[];
  values: Record<string, unknown>;
  origin: string;
  at: number;
};
export type ChangesResult = { changes: Change[]; lastSeq: number };
export type ProspectSearchResult = { rows: Array<AccountInput & { fit?: number }>; total: number };
export type HealthResult = { ok: true; version: string; openWorkspaces: number };
export type ErrorResult = { error: string; issues?: unknown };

// ---------- object-layer projections (CP1f) ----------
// Bodies are shape-checked here; src/core/objects/listSpec.ts checks them
// against the object's registry (field names, ops per type, value types).

const FilterScalar = z.union([z.string().max(512), z.number().finite(), z.boolean()]);
export const ProjectionFilter = z.object({
  field: z.string().min(1).max(128),
  op: z.enum(["eq", "neq", "in", "contains", "startsWith", "gt", "gte", "lt", "lte", "hasAny", "hasAll", "empty", "notEmpty"]),
  value: z.union([FilterScalar, z.array(FilterScalar).min(1).max(500)]).optional(),
}).strict();
export const ProjectionListBody = z.object({
  filter: z.array(ProjectionFilter).max(20).optional(),
  sort: z.object({ field: z.string().min(1).max(128), dir: z.enum(["asc", "desc"]) }).strict().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  // A cursor carries the last row's sort value, which can be any stored text (a
  // Convex document is at most 1 MiB), so only the request body limit bounds it.
  cursor: z.string().optional(),
  deleted: z.boolean().optional(),
  scope: OwnerScopeBody.optional(),
}).strict();
export type ProjectionListBody = z.infer<typeof ProjectionListBody>;
/** A report (CP9, 1.27.0): the list's filters, up to three group keys (1.35.0) and up to five measures; src/core/objects/reportSpec.ts checks the rest. */
export const AggregateBody = z.object({
  filter: z.array(ProjectionFilter).max(20).optional(),
  groupBy: z.array(z.object({
    field: z.string().min(1).max(128),
    via: z.string().min(1).max(128).optional(),
    bucket: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
  }).strict()).max(3).optional(),
  measures: z.array(z.object({ fn: z.enum(["count", "sum", "avg", "min", "max"]), field: z.string().min(1).max(128).optional(), weight: z.string().min(1).max(128).optional() }).strict()).min(1).max(5),
  scope: OwnerScopeBody.optional(),
}).strict();
export type AggregateBody = z.infer<typeof AggregateBody>;
/** A module doc as Canon projects it (1.33.0, src/core/objects/moduleReport.ts). */
const ModuleKey = z.string().min(1).max(200);
const ModuleCollection = z.string().min(1).max(40);
const ModuleDocBody = z.object({
  collection: ModuleCollection, key: ModuleKey, parentKey: ModuleKey.nullable(), gen: z.number().int().nullable(), gens: z.record(z.string(), z.number().int()).nullable(),
  owner: z.string().max(64).nullable(), data: z.record(z.string(), z.unknown()), version: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(),
}).strict();
const ProjectionSequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const ModuleProjectionBody = z.object({
  packageId: z.string().min(1).max(128), epoch: ProjectionSequence, generation: ProjectionSequence,
  collections: z.array(ModuleCollection).max(100),
}).strict();
const ModuleProjectionWorkBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keys"), keys: z.array(z.object({ collection: ModuleCollection, key: ModuleKey, job: z.string().min(1).max(128), seq: ProjectionSequence }).strict()).max(2500) }).strict(),
  z.object({ kind: z.literal("rebuild"), collection: ModuleCollection, job: z.string().min(1).max(128), seq: ProjectionSequence, complete: z.boolean() }).strict(),
]);
export const ModuleSyncBody = z.object({
  upserts: z.array(ModuleDocBody).max(500),
  deletes: z.array(z.object({ collection: ModuleCollection, key: ModuleKey }).strict()).max(2000),
  sweep: z.object({ collection: ModuleCollection, before: z.number() }).strict().optional(),
  projection: ModuleProjectionBody.optional(), work: ModuleProjectionWorkBody.optional(),
}).strict();
export type ModuleSyncBody = z.infer<typeof ModuleSyncBody>;
const ModuleScalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
type ModuleWhereBody = { field: string; in: Array<string | number | boolean | null> } | { field: string; neq: string | number | boolean | null } | { all: ModuleWhereBody[] } | { ref: string; collection: string; where: ModuleWhereBody };
const ModuleWhereBody: z.ZodType<ModuleWhereBody> = z.lazy(() => z.union([
  z.object({ field: z.string().min(1).max(40), in: z.array(ModuleScalar).min(1).max(50) }).strict(),
  z.object({ field: z.string().min(1).max(40), neq: ModuleScalar }).strict(),
  z.object({ all: z.array(ModuleWhereBody).min(1).max(5) }).strict(),
  z.object({ ref: z.string().min(1).max(40), collection: ModuleCollection, where: ModuleWhereBody }).strict(),
]));
type ModuleDocScopeBody = { owners: string[] | null; where: ModuleWhereBody | null; setOf: { parent: string; scope: ModuleDocScopeBody } | null };
const ModuleDocScopeBody: z.ZodType<ModuleDocScopeBody> = z.lazy(() => z.object({
  owners: z.array(z.string().max(64)).max(5000).nullable(), where: ModuleWhereBody.nullable(),
  setOf: z.object({ parent: ModuleCollection, scope: ModuleDocScopeBody }).strict().nullable(),
}).strict());
export const ActivityAggregateBody = AggregateBody.extend({
  moduleActivities: z.array(z.object({
    module: z.string().min(1).max(128), collection: ModuleCollection,
    kind: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), owner: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/).nullable(),
    scopes: z.array(ModuleDocScopeBody).min(1).max(100), projection: ModuleProjectionBody,
  }).strict()).max(100).optional(),
}).strict();
export type ActivityAggregateBody = z.infer<typeof ActivityAggregateBody>;
export const ModuleAggregateBody = AggregateBody.omit({ scope: true }).extend({
  collection: ModuleCollection,
  fields: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), label: z.string().max(80),
    type: z.enum(["text", "picklist", "user", "number", "currency", "date", "datetime", "checkbox"]),
    options: z.array(z.object({ value: z.string().max(200), label: z.string().max(200) }).strict()).max(200).optional(),
  }).strict()).min(1).max(40),
  docScope: ModuleDocScopeBody.nullable(),
  projection: ModuleProjectionBody.optional(),
}).strict();
export type ModuleAggregateBody = z.infer<typeof ModuleAggregateBody>;
export const DuplicatesBody = z.object({ limit: z.number().int().min(1).max(2000).optional(), scope: LegacyScope.optional() }).strict();
export type DuplicatesBody = z.infer<typeof DuplicatesBody>;
export const ProjectionSearchBody = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional(),
  perObject: z.number().int().min(1).max(50).optional(),
  objects: z.array(ObjectName).max(20).optional(),
  scopes: z.record(ObjectName, OwnerScopeBody).optional(),
}).strict();
export type ProjectionSearchBody = z.infer<typeof ProjectionSearchBody>;
/** Convex's shard heads after a save; the projector pulls every shard it is behind on. `wait` answers after applying. */
/** Convex's HTTP site, which the projector pulls from: https, or http on the loopback for local stacks. */
const LedgerSourceUrl = z.string().max(500).url().refine((u) => {
  const url = new URL(u);
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}, "must be https, or http on the loopback");

export const ProjectorNudgeBody = z.object({
  heads: z.record(z.string().regex(/^(1[0-5]|[0-9])$/), z.number().int().nonnegative()).optional(),
  source: LedgerSourceUrl.optional(),
  wait: z.boolean().optional(),
}).strict();
export const ProjectorRebuildBody = z.object({ object: ObjectName }).strict();

/** Route table, for clients. */
export const ROUTES = {
  healthz: "GET /healthz",
  metrics: "GET /metrics",
  provision: "POST /v1/workspaces/{ws}/provision",
  upsertAccounts: "POST /v1/workspaces/{ws}/accounts/upsert",
  upsertContacts: "POST /v1/workspaces/{ws}/contacts/upsert",
  listAccounts: "POST /v1/workspaces/{ws}/accounts/list",
  getAccount: "POST /v1/workspaces/{ws}/accounts/get",
  listContacts: "POST /v1/workspaces/{ws}/contacts/list",
  getContact: "POST /v1/workspaces/{ws}/contacts/get",
  edit: "POST /v1/workspaces/{ws}/records/edit",
  segmentCount: "POST /v1/workspaces/{ws}/segments/count",
  facets: "POST /v1/workspaces/{ws}/accounts/facets",
  annotate: "POST /v1/workspaces/{ws}/accounts/annotate",
  rescore: "POST /v1/workspaces/{ws}/rescore",
  icpStats: "POST /v1/workspaces/{ws}/icp-stats",
  icpTreeCounts: "POST /v1/workspaces/{ws}/icp-tree/counts",
  territoryTreeCounts: "POST /v1/workspaces/{ws}/territory-tree/counts",
  prospectFacets: "POST /v1/shared/prospects/facets",
  changes: "GET /v1/workspaces/{ws}/changes?after=<seq>&limit=500",
  defineObjects: "POST /v1/workspaces/{ws}/objects/define",
  upsertObjects: "POST /v1/workspaces/{ws}/objects/{object}/upsert",
  listObjects: "POST /v1/workspaces/{ws}/objects/{object}/list",
  getObject: "POST /v1/workspaces/{ws}/objects/{object}/get",
  editObject: "POST /v1/workspaces/{ws}/objects/{object}/edit",
  history: "POST /v1/workspaces/{ws}/history",
  prospectSearch: "POST /v1/shared/prospects/search",
  prospectLookup: "POST /v1/shared/prospects/lookup",
  projectionList: "POST /v1/workspaces/{ws}/p/{object}/list",
  projectionSearch: "POST /v1/workspaces/{ws}/p/search",
  registerList: "POST /v1/workspaces/{ws}/register/{account,contact}/list",
  registerDuplicates: "POST /v1/workspaces/{ws}/register/{account,contact}/duplicates",
  projectorNudge: "POST /v1/workspaces/{ws}/projector/nudge",
  projectorRebuild: "POST /v1/workspaces/{ws}/projector/rebuild",
} as const;
