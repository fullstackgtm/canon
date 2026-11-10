/**
 * CSV import (CP10, CP10b). A person uploads a file, maps its columns,
 * previews what every row will do, then runs the import as a background job
 * in the activity tray. The rules are in lib/objects/csvImport.ts (companies,
 * people, deals) and lib/objects/csvRecords.ts (activities and every other
 * object); this file reads the file, looks dedupe keys, companies, people,
 * deals and owners up, and writes batches of rows: companies and people
 * through the ledger, deals through the deal save path (deals.ts insertDeal
 * and saveDealEdit), everything else through the object API's `save`, with an
 * `activity_target` edge from each activity to the records it is about.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { requireUnrestricted } from "./permissions";
import { clientFor } from "./records";
import { partyStores, partySyncHasBudget } from "./canon";
import { insertDeal, saveDealEdit } from "./deals";
import { setDealRoles } from "./dealCommittee";
import { edgeStore } from "./associations";
import { convexObjectStore, loadDef } from "./objects";
import { orgPipelines } from "./pipelines";
import { planDealCreate } from "./lib/pipelines";
import type { ScalarFactValue as FactValue } from "./lib/canon/policy";
import { normalizeDomain, normalizeEmail } from "./lib/canon/identity";
import { resubmitUnprocessed, syncPartyBatch, type PartyObject, type PartyValues, type RecordAccountSnapshot, type RecordContactSnapshot } from "./lib/canon/partyLedger";
import {
  autoMap, cellDomain, classify, classifyDeals, companyCells, dealCreateInput, importColumns, importIdOf, importKeys, IMPORT_ROWS_MAX, matchCompanies,
  ownerEmails, parseCsv, personEmails, readRows, summarize, writeImportRow,
  type CompanyLink, type DealMatch, type DealOutcome, type ImportMapping, type ImportMatch, type ImportObject, type ImportPreview,
  type ImportWrite, type RegisterCompany, type RowOutcome,
} from "./lib/objects/csvImport";
import {
  ACTIVITY, autoMapRecord, classifyRecords, isActivityObject, isRecordObject, readRecordRows, recordColumns, recordKeys,
  type Column, type DealRef, type RecordDefs, type RecordOutcome,
} from "./lib/objects/csvRecords";
import { ACTIVITY_OBJECTS } from "./lib/activities";
import { applyEdgeCommand } from "./lib/objects/associations";
import { save, type SaveCommand, type SaveContext } from "./lib/objects/write";
import type { RegisterListRow } from "./lib/objects/listSpec";
import { allValuesOf, resolveObjectDef, STANDARD_OBJECTS, type DealRole, type OrgObjectExtension, type ResolvedObjectDef, type StandardObjectName } from "./lib/objects/registry";
import { fieldValue, fromStored, toStored } from "./lib/objects/validators";
import type { RecordClient } from "./lib/recordClient";

/**
 * Rows one mutation writes, one batch in flight per org (docs/cp0-object-layer.md, "Convex import rate").
 * A new account or contact costs about 10 ms here (identity, stream, the `facts` mirror; 25 rows took up to
 * 710 ms locally), so 20 keeps a batch well inside Convex's 1 s. Convex mutations see a frozen clock, so
 * the budget is a row count, not a time.
 */
const WRITE_BATCH = 20;
/** Dedupe keys per register lookup: the list's `in` filter takes up to 500 values and returns up to 200 rows. */
const LOOKUP_BATCH = 100;
/** Company cells per register lookup, by domain and by name: a name may match several companies. */
const COMPANY_LOOKUP_BATCH = 50;
/** Canon deals one name may match; the same name past this many is not looked at. */
const DEALS_PER_NAME = 100;
/** Names per deal lookup: each reads up to DEALS_PER_NAME deals. */
const DEAL_NAMES_BATCH = 25;
/** Rows of one activity or record batch: each may write a stream and up to three edges. */
const RECORD_BATCH = 20;
/** File rows per lookup of the rows an earlier run of the file wrote. */
const SEEN_BATCH = 500;

/** What an `object` argument names: a company or person (ledger), a deal, or records (activities, leads, products, any registry object). */
type Target = { kind: "party"; object: PartyObject } | { kind: "deal" } | { kind: "records"; object: string };

function targetOf(object: string): Target {
  if (object === "account" || object === "contact") return { kind: "party", object };
  if (object === "deal") return { kind: "deal" };
  if (object === ACTIVITY || isRecordObject(object)) return { kind: "records", object };
  throw new ConvexError(`${object} cannot be imported from a CSV file`);
}

const objectArg = v.string();
const partyArg = v.union(v.literal("account"), v.literal("contact"));
const mappingArg = v.array(v.union(v.string(), v.null()));
/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds imports.run. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "imports.run");

export const importer = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!isManager(user)) throw new ConvexError("Only admins and managers can import records");
    await requireUnrestricted(ctx, "a CSV import, which matches every record");
    return { orgId: user.orgId, userId: user._id };
  },
});

/** The org's extension of the object (custom fields, its own picklist options). */
export const objectExtension = internalQuery({
  args: { orgId: v.id("organizations"), object: v.string() },
  handler: async (ctx, args): Promise<OrgObjectExtension | null> => {
    const ext = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", args.orgId).eq("apiName", args.object)).unique();
    return ext ? fromStored<OrgObjectExtension>(ext) : null;
  },
});

export const pipelinesOf = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => orgPipelines(ctx, args.orgId),
});

/** The org's deals with these exact names, and the company each is linked to. */
export const dealsNamed = internalQuery({
  args: { orgId: v.id("organizations"), names: v.array(v.string()) },
  handler: async (ctx, args) => {
    const found = await Promise.all(args.names.map((name) =>
      ctx.db.query("deals").withIndex("by_orgId_name", (q) => q.eq("orgId", args.orgId).eq("name", name)).take(DEALS_PER_NAME)));
    return found.flat().map((d) => ({ name: d.name, dealId: d._id, companyId: d.companyId ?? null, crmAccount: d.accountId !== undefined }));
  },
});

/**
 * The deals an activity's Deal cells name, each by its stream id (what an `activity_target` edge points at) or its exact
 * name. A deal that is not on the ledger yet has no stream to point at, so it is left out.
 */
export const dealsByRef = internalQuery({
  args: { orgId: v.id("organizations"), cells: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<{ cell: string; streamId: string; companyId: string | null }>> => {
    const streamOf = async (dealId: Id<"deals">) =>
      (await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", args.orgId).eq("projectionId", dealId)).first())?._id ?? null;
    const found = await Promise.all(args.cells.map(async (cell) => {
      const id = ctx.db.normalizeId("canonEntities", cell);
      const entity = id ? await ctx.db.get(id) : null;
      if (entity && entity.orgId === args.orgId && entity.projectionTable === "deals") {
        const dealId = ctx.db.normalizeId("deals", entity.projectionId);
        const deal = dealId ? await ctx.db.get(dealId) : null;
        return deal ? [{ cell, streamId: entity._id as string, companyId: deal.companyId ?? null }] : [];
      }
      const deals = await ctx.db.query("deals").withIndex("by_orgId_name", (q) => q.eq("orgId", args.orgId).eq("name", cell)).take(DEALS_PER_NAME);
      const streams = await Promise.all(deals.map((d) => streamOf(d._id)));
      return deals.flatMap((d, i) => (streams[i] ? [{ cell, streamId: streams[i] as string, companyId: d.companyId ?? null }] : []));
    }));
    return found.flat();
  },
});

/** The org members with these (lowercased) emails: who an Owner cell names. */
export const membersByEmail = internalQuery({
  args: { orgId: v.id("organizations"), emails: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<{ email: string; userId: string }>> => {
    const found = await Promise.all(args.emails.map((email) =>
      ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", args.orgId).eq("email", email)).first()));
    return found.flatMap((u, i) => (u ? [{ email: args.emails[i], userId: u._id as string }] : []));
  },
});

/** Which of these file rows an earlier run of the file already wrote (its row external id exists): a re-run finds them again. */
export const rowsSeen = internalQuery({
  args: { orgId: v.id("organizations"), provider: v.string(), rows: v.array(v.number()) },
  handler: async (ctx, args): Promise<number[]> => {
    const found = await Promise.all(args.rows.map((row) => ctx.db.query("canonExternalIds")
      .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", args.orgId).eq("provider", args.provider).eq("externalId", String(row))).first()));
    return args.rows.filter((_, i) => found[i]);
  },
});

/** An import's progress and, once it ends, what it did: the job `start` returned, in the caller's workspace. */
export const job = query({
  args: { jobId: v.id("backgroundJobs") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const job = user ? await ctx.db.get(args.jobId) : null;
    if (!job || job.orgId !== user!.orgId) return null;
    const rows = job.phases.find((p) => p.key === "rows");
    return { status: job.status, detail: job.detail ?? null, error: job.error ?? null, done: rows?.done ?? null, total: rows?.total ?? null, href: job.href };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (!isManager(user)) throw new ConvexError("Only admins and managers can import records");
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Record the caller's org as the uploader of a file, right after uploading it. The caller proves it holds
 * the file by its SHA-256 (base64, as Convex stores it), so knowing a storage id is not enough to claim it.
 */
export const claimUpload = mutation({
  args: { storageId: v.id("_storage"), sha256: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!isManager(user)) throw new ConvexError("Only admins and managers can import records");
    const file = await ctx.db.system.get(args.storageId);
    if (!file || file.sha256 !== args.sha256) throw new ConvexError("Upload not found");
    const claim = await ctx.db.query("csvUploads").withIndex("by_storageId", (q) => q.eq("storageId", args.storageId)).unique();
    if (claim && claim.orgId !== user.orgId) throw new ConvexError("Upload not found");
    if (!claim) await ctx.db.insert("csvUploads", { orgId: user.orgId, storageId: args.storageId });
    return null;
  },
});

export const uploadOwner = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => (await ctx.db.query("csvUploads").withIndex("by_storageId", (q) => q.eq("storageId", args.storageId)).unique())?.orgId ?? null,
});

export const releaseUpload = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const claim = await ctx.db.query("csvUploads").withIndex("by_storageId", (q) => q.eq("storageId", args.storageId)).unique();
    if (claim) await ctx.db.delete(claim._id);
    await ctx.storage.delete(args.storageId);
  },
});

function snapshotOf(object: PartyObject, r: RegisterListRow): RecordAccountSnapshot | RecordContactSnapshot {
  const text = (k: string) => (typeof r.values[k] === "string" && r.values[k] ? { [k]: r.values[k] as string } : {});
  if (object === "contact") return { id: r.id, fullName: String(r.values.fullName ?? r.title ?? ""), updatedAt: r.updatedAt, ...text("email"), ...text("title"), ...text("linkedinUrl") };
  const employees = typeof r.values.employees === "number" ? { employees: r.values.employees } : {};
  return {
    id: r.id, domain: String(r.values.domain ?? ""), name: String(r.values.name ?? r.title ?? ""), updatedAt: r.updatedAt, ...employees,
    ...text("industry"), ...text("country"), ...text("linkedinUrl"), ...text("status"), ...text("ownerId"),
  };
}

/** The register rows the keys name: accounts by domain, contacts by email. */
async function lookupMatches(client: RecordClient, ws: string, object: PartyObject, keys: readonly string[]): Promise<Map<string, ImportMatch>> {
  const field = object === "account" ? "domain" : "email";
  const out = new Map<string, ImportMatch>();
  for (let i = 0; i < keys.length; i += LOOKUP_BATCH) {
    const page = await client.listRegister(ws, object, { filter: [{ field, op: "in", value: keys.slice(i, i + LOOKUP_BATCH) }], limit: 200 });
    for (const r of page.rows) {
      const raw = String(r.values[field] ?? "");
      // A person is found by any of their emails (record service 1.28.0): each one names them.
      const keys = object === "account" ? [normalizeDomain(raw)] : allValuesOf(raw, r.values.additionalEmails).map(normalizeEmail);
      for (const key of keys) if (key && !out.has(key)) out.set(key, { recordId: r.id, stream: r.stream, snapshot: snapshotOf(object, r) });
    }
  }
  return out;
}

/** The register companies the Company cells may name: by domain, and by exact name. */
async function lookupCompanies(client: RecordClient, ws: string, cells: readonly string[]): Promise<RegisterCompany[]> {
  const out = new Map<string, RegisterCompany>();
  const domains = [...new Set(cells.flatMap((c) => cellDomain(c) ?? []))];
  for (const [field, values] of [["domain", domains], ["name", cells]] as const) {
    for (let i = 0; i < values.length; i += COMPANY_LOOKUP_BATCH) {
      const page = await client.listRegister(ws, "account", { filter: [{ field, op: "in", value: values.slice(i, i + COMPANY_LOOKUP_BATCH) }], limit: 200 });
      for (const r of page.rows) out.set(r.id, { id: r.id, name: String(r.values.name ?? r.title ?? ""), domain: String(r.values.domain ?? "") });
    }
  }
  return [...out.values()];
}

/** The org's deals by name, for the names the rows carry. */
async function lookupDeals(ctx: ActionCtx, orgId: Id<"organizations">, names: readonly string[]): Promise<Map<string, DealMatch[]>> {
  const out = new Map<string, DealMatch[]>();
  for (let i = 0; i < names.length; i += DEAL_NAMES_BATCH) {
    for (const d of await ctx.runQuery(internal.csvImports.dealsNamed, { orgId, names: names.slice(i, i + DEAL_NAMES_BATCH) })) {
      out.set(d.name, [...(out.get(d.name) ?? []), { dealId: d.dealId, companyId: d.companyId, crmAccount: d.crmAccount }]);
    }
  }
  return out;
}

/** The register contacts the (lowercased) emails name, by email. */
async function lookupPeople(client: RecordClient, ws: string, emails: readonly string[]): Promise<Map<string, string>> {
  const found = emails.length ? await lookupMatches(client, ws, "contact", emails) : new Map<string, ImportMatch>();
  return new Map([...found].map(([email, m]) => [email, m.recordId]));
}

/** The file rows an earlier run of this file wrote under `provider`. */
async function lookupSeen(ctx: ActionCtx, orgId: Id<"organizations">, provider: string, rows: readonly number[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i += SEEN_BATCH) out.push(...await ctx.runQuery(internal.csvImports.rowsSeen, { orgId, provider, rows: rows.slice(i, i + SEEN_BATCH) }));
  return out;
}

type PlanBase = { columns: Column[]; header: string[]; mapping: ImportMapping; importId: string };
type Plan = PlanBase & (
  | { object: PartyObject; def: ResolvedObjectDef; outcomes: RowOutcome[] }
  | { object: "deal"; def: ResolvedObjectDef; outcomes: DealOutcome[] }
  | { object: "records"; name: string; outcomes: RecordOutcome[] }
);
type PlanArgs = {
  orgId: Id<"organizations">; object: string; storageId: Id<"_storage">; mapping?: ImportMapping; createCompanies?: boolean;
  /** The type an activity row with no Type cell is (a Tasks page imports tasks). */
  kind?: string;
  /** Import an activity row that matches no company, person or deal. */
  allowUntargeted?: boolean;
  /** Skip a deal row whose Owner cell names no member (else the importer owns it). */
  skipUnknownOwners?: boolean;
  /** A deal Stage cell (lower-cased) to the stage it imports as: a stage no pipeline has, mapped in the review step. */
  stageMap?: Record<string, string>;
};

const defOf = async (ctx: ActionCtx, orgId: Id<"organizations">, object: string) => {
  const ext = await ctx.runQuery(internal.csvImports.objectExtension, { orgId, object });
  return resolveObjectDef(STANDARD_OBJECTS[object as StandardObjectName], ext ?? undefined);
};

/** Read the uploaded file and decide what every row does, as the job will. */
async function planFile(ctx: ActionCtx, a: PlanArgs): Promise<Plan> {
  const target = targetOf(a.object);
  const owner = await ctx.runQuery(internal.csvImports.uploadOwner, { storageId: a.storageId });
  const blob = owner === a.orgId ? await ctx.storage.get(a.storageId) : null;
  if (!blob) throw new ConvexError("The uploaded file is gone; upload it again");
  const text = await blob.text();
  const records = parseCsv(text);
  if (records.length < 2) throw new ConvexError("The file needs a header row and at least one row");
  if (records.length - 1 > IMPORT_ROWS_MAX) throw new ConvexError(`Import at most ${IMPORT_ROWS_MAX.toLocaleString("en-US")} rows at a time`);
  const header = records[0].map((h) => h.trim());
  const importId = importIdOf(a.object, text);
  const client = clientFor(ctx);
  const fit = (columns: readonly Column[], mapping: ImportMapping) => {
    const allowed = new Set(columns.map((f) => f.apiName));
    if (mapping.length !== header.length || mapping.some((m) => m !== null && !allowed.has(m))) throw new ConvexError("The column mapping does not fit this file");
  };

  if (target.kind === "records") {
    if (a.kind !== undefined && !isActivityObject(a.kind)) throw new ConvexError(`${a.kind} is not an activity type`);
    const names = target.object === ACTIVITY ? [...ACTIVITY_OBJECTS] : [target.object];
    const defs: RecordDefs = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await defOf(ctx, a.orgId, n)] as const)));
    if (names.some((n) => defs[n].fields.some((f) => f.required && f.type === "lookup" && f.archivedAt === undefined))) {
      throw new ConvexError(`${STANDARD_OBJECTS[target.object as StandardObjectName]?.pluralLabel ?? target.object} link to other records and cannot be imported from a CSV file`);
    }
    const columns = recordColumns(target.object, defs, a.kind);
    const mapping = a.mapping ?? autoMapRecord(target.object, columns, header);
    fit(columns, mapping);
    const read = readRecordRows(target.object, defs, mapping, records, { kind: a.kind });
    const keys = recordKeys(read);
    const [members, companyRows, people, dealRefs] = await Promise.all([
      keys.owners.length ? ctx.runQuery(internal.csvImports.membersByEmail, { orgId: a.orgId, emails: keys.owners }) : [],
      keys.companies.length ? lookupCompanies(client, a.orgId, keys.companies) : [],
      lookupPeople(client, a.orgId, keys.people),
      keys.deals.length ? ctx.runQuery(internal.csvImports.dealsByRef, { orgId: a.orgId, cells: keys.deals }) : [],
    ]);
    const deals = new Map<string, DealRef[]>();
    for (const d of dealRefs) deals.set(d.cell, [...(deals.get(d.cell) ?? []), { streamId: d.streamId, companyId: d.companyId }]);
    const again = new Set<number>();
    for (const kind of new Set(read.flatMap((r) => (r.kind === "record" ? [r.object] : [])))) {
      const rows = read.flatMap((r) => (r.kind === "record" && r.object === kind ? [r.row] : []));
      for (const row of await lookupSeen(ctx, a.orgId, `csv:${importId}:${kind}`, rows)) again.add(row);
    }
    const outcomes = classifyRecords(read, defs, {
      members: new Map(members.map((m) => [m.email, m.userId])), companies: matchCompanies(keys.companies, companyRows, false), people, deals, again,
    }, { allowUntargeted: a.allowUntargeted ?? false });
    return { columns, header, mapping, importId, object: "records", name: target.object, outcomes };
  }

  const def = await defOf(ctx, a.orgId, a.object);
  const columns = importColumns(target.kind === "deal" ? "deal" : target.object, def);
  const mapping = a.mapping ?? autoMap(target.kind === "deal" ? "deal" : target.object, def, header);
  fit(columns, mapping);
  const pipelines = target.kind === "deal" ? await ctx.runQuery(internal.csvImports.pipelinesOf, { orgId: a.orgId }) : [];
  const read = readRows(target.kind === "deal" ? "deal" : target.object, def, mapping, records, pipelines, a.stageMap);
  const cells = companyCells(read);
  const companies = matchCompanies(cells, cells.length ? await lookupCompanies(client, a.orgId, cells) : [], a.createCompanies ?? false);
  const base = { columns, header, mapping, importId, def };
  if (target.kind === "deal") {
    const emails = ownerEmails(read);
    const [deals, people, owners] = await Promise.all([
      lookupDeals(ctx, a.orgId, importKeys(read)), lookupPeople(client, a.orgId, personEmails(read)),
      emails.length ? ctx.runQuery(internal.csvImports.membersByEmail, { orgId: a.orgId, emails }) : [],
    ]);
    return { ...base, object: "deal", outcomes: classifyDeals(read, deals, companies, pipelines, mapping.includes("company"), def, people, new Map(owners.map((o) => [o.email, o.userId])), a.skipUnknownOwners ?? false) };
  }
  const matches = await lookupMatches(client, a.orgId, target.object, importKeys(read));
  // A row with no key is found again by its file row: an earlier run of this file already wrote it.
  const keyless = read.flatMap((r) => (r.kind === "read" && !r.key ? [r.row] : []));
  const again = new Set(keyless.length ? await lookupSeen(ctx, a.orgId, `csv:${importId}`, keyless) : []);
  return { ...base, object: target.object, outcomes: classify(target.object, def, read, matches, companies, again) };
}

/** The file's columns, their mapping (auto-matched when none is given), and what the import would do. Nothing is written. */
export const preview = action({
  args: {
    object: objectArg, storageId: v.id("_storage"), mapping: v.optional(mappingArg), createCompanies: v.optional(v.boolean()),
    kind: v.optional(v.string()), allowUntargeted: v.optional(v.boolean()), skipUnknownOwners: v.optional(v.boolean()), stageMap: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args): Promise<ImportPreview & { header: string[]; mapping: ImportMapping; fields: Column[] }> => {
    const who = await ctx.runQuery(internal.csvImports.importer, {});
    const plan = await planFile(ctx, { ...args, orgId: who.orgId });
    return { ...summarize(plan.outcomes), header: plan.header, mapping: plan.mapping, fields: plan.columns };
  },
});

/** Start the import as a background job; its progress shows in the activity tray. */
export const start = action({
  args: {
    object: objectArg, storageId: v.id("_storage"), mapping: mappingArg, createCompanies: v.optional(v.boolean()),
    kind: v.optional(v.string()), allowUntargeted: v.optional(v.boolean()), skipUnknownOwners: v.optional(v.boolean()), stageMap: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"backgroundJobs"> }> => {
    const who = await ctx.runQuery(internal.csvImports.importer, {});
    const target = targetOf(args.object);
    const label = args.object === ACTIVITY ? "activities" : STANDARD_OBJECTS[args.object as StandardObjectName].pluralLabel.toLowerCase();
    const jobId: Id<"backgroundJobs"> = await ctx.runMutation(internal.backgroundJobs.create, {
      orgId: who.orgId, kind: "contact_sweep", title: `Import ${label}`, detail: "Reading the file…",
      href: target.kind === "deal" ? "/dashboard/deals" : `/dashboard/records/${args.object === ACTIVITY ? args.kind ?? "task" : args.object}`,
      phases: [{ key: "rows", label: "Rows", status: "processing" }],
    });
    await ctx.scheduler.runAfter(0, internal.csvImports.run, { ...args, jobId, orgId: who.orgId, userId: who.userId });
    return { jobId };
  },
});

const matchArg = v.object({ recordId: v.string(), stream: v.union(v.string(), v.null()), snapshot: v.record(v.string(), v.union(v.string(), v.number())) });
const values = v.record(v.string(), fieldValue);
const writeRow = v.union(
  v.object({ kind: v.literal("create"), row: v.number(), key: v.union(v.string(), v.null()), values }),
  v.object({ kind: v.literal("update"), row: v.number(), key: v.string(), values, match: matchArg }),
);
const dealValues = v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()));
const companyArg = v.union(v.string(), v.null());
// `ownerId`: the member the row's Owner cell names (a new deal is the importer's without one). `columns`: values the
// deals row holds and the ledger doesn't (DealColumns), written on the row.
const dealColumns = v.optional(v.object({
  revenueType: v.optional(v.union(v.literal("one_time"), v.literal("recurring"))), contractLengthMonths: v.optional(v.number()), products: v.optional(v.array(v.string())),
}));
const dealRow = v.union(
  v.object({ kind: v.literal("create"), row: v.number(), values: dealValues, companyId: companyArg, ownerId: v.optional(v.string()), columns: dealColumns }),
  v.object({ kind: v.literal("update"), row: v.number(), values: dealValues, companyId: companyArg, dealId: v.string(), ownerId: v.optional(v.string()), columns: dealColumns }),
);
type DealRow = typeof dealRow.type;
type Tally = { created: number; updated: number; unchanged: number; failed: Array<{ row: number; message: string }> };

/** A deal row's values as the deal ledger takes them (no deal import field holds a list). */
const factValues = (values: PartyValues): Record<string, FactValue> =>
  Object.fromEntries(Object.entries(values).flatMap(([k, val]) => (typeof val === "object" && val !== null ? [] : [[k, val]])));

/** A company or person row as writeBatch takes it: list values copied out of their frozen arrays. */
function wire(w: ImportWrite): typeof writeRow.type {
  const values = toStored(w.values);
  return w.kind === "create" ? { ...w, values } : { ...w, values, match: { ...w.match, snapshot: { ...w.match.snapshot } } };
}

/**
 * Create the companies Company cells name and the register lacks, through the
 * ledger as a company import's rows are (source `csv:<importId>.company:<row>`),
 * then wait for the register to list them. Returns each cell's company id.
 */
async function createCompanies(ctx: ActionCtx, client: RecordClient, a: { orgId: Id<"organizations">; userId: Id<"users"> }, plan: Plan): Promise<Map<string, string>> {
  const firstRow = new Map<string, number>();
  if (plan.object === "records") return new Map();
  for (const o of plan.outcomes) {
    if (o.kind !== "create" && o.kind !== "update") continue;
    for (const link of [o.company, ...(o.links ?? [])]) if (link?.kind === "created" && !firstRow.has(link.cell)) firstRow.set(link.cell, o.row);
  }
  if (!firstRow.size) return new Map();
  const rows: ImportWrite[] = [...firstRow].map(([cell, row]) => {
    const domain = cellDomain(cell);
    const values: PartyValues = domain ? { name: cell, domain } : { name: cell };
    return { kind: "create", row, key: domain, values };
  });
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    await resubmitUnprocessed(rows.slice(i, i + WRITE_BATCH), async (batch) => {
      const out = await ctx.runMutation(internal.csvImports.writeBatch, { orgId: a.orgId, userId: a.userId, object: "account", importId: `${plan.importId}.company`, rows: batch.map(wire) });
      return batch.filter((r) => out.unprocessed.includes(r.row));
    });
  }
  await settle(ctx, client, a.orgId);
  const cells = [...firstRow.keys()];
  const found = matchCompanies(cells, await lookupCompanies(client, a.orgId, cells), false);
  return new Map(cells.flatMap((cell) => {
    const m = found.get(cell);
    return m?.kind === "linked" ? [[cell, m.companyId] as const] : [];
  }));
}

/** Wait until the record service has projected the org's ledger, so the register lists what was just written. */
async function settle(ctx: ActionCtx, client: RecordClient, orgId: Id<"organizations">) {
  if (client.mode === "http") await client.nudgeProjector(orgId, await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId }), process.env.CONVEX_SITE_URL, { wait: true });
}

/**
 * Link each person of a Companies column to its companies, the first primary unless the person already has a primary
 * (`contact_account` edges, as the record page's links make them). The edges need the person's register id, which
 * exists once the record service has projected the import; a row whose person never reached the register fails.
 */
async function linkCompanies(
  ctx: ActionCtx, client: RecordClient, a: { orgId: Id<"organizations">; userId: Id<"users"> },
  writes: ReadonlyArray<Extract<RowOutcome, { kind: "create" | "update" }>>, failedRows: ReadonlySet<number>,
  companyIdOf: (link: CompanyLink | null) => string | null | undefined, fail: (row: number, message: string) => void,
) {
  const rows = writes.flatMap((o) => {
    if (!o.links?.length || !o.key || failedRows.has(o.row)) return [];
    const ids = [...new Set([o.company, ...o.links].map(companyIdOf).filter((id): id is string => !!id))];
    return ids.length ? [{ row: o.row, email: o.key, companyIds: ids }] : [];
  });
  if (!rows.length) return;
  await settle(ctx, client, a.orgId);
  const people = new Map<string, { id: string; accountId: string }>();
  for (let i = 0; i < rows.length; i += LOOKUP_BATCH) {
    const page = await client.listRegister(a.orgId, "contact", { filter: [{ field: "email", op: "in", value: rows.slice(i, i + LOOKUP_BATCH).map((r) => r.email) }], limit: 200 });
    for (const r of page.rows) for (const e of allValuesOf(r.values.email, r.values.additionalEmails)) people.set(normalizeEmail(e), { id: r.id, accountId: r.accountId ?? "" });
  }
  const linkable = rows.flatMap((r) => {
    const person = people.get(r.email);
    if (!person) {
      fail(r.row, `${r.email} is not in the register yet, so its companies were not linked`);
      return [];
    }
    return [{ row: r.row, contactId: person.id, ...(person.accountId ? { seed: person.accountId } : {}), companyIds: r.companyIds }];
  });
  for (let i = 0; i < linkable.length; i += WRITE_BATCH) {
    const batch = linkable.slice(i, i + WRITE_BATCH);
    const out = await ctx.runMutation(internal.csvImports.writeCompanyLinks, { orgId: a.orgId, userId: a.userId, rows: batch });
    for (const f of out.failed) fail(f.row, f.message);
  }
}

export const run = internalAction({
  args: {
    jobId: v.id("backgroundJobs"), orgId: v.id("organizations"), userId: v.id("users"), object: objectArg,
    storageId: v.id("_storage"), mapping: mappingArg, createCompanies: v.optional(v.boolean()),
    kind: v.optional(v.string()), allowUntargeted: v.optional(v.boolean()), skipUnknownOwners: v.optional(v.boolean()), stageMap: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, a) => {
    const update = (patch: { detail?: string; status?: "completed" | "failed"; error?: string; done?: number; total?: number }) =>
      ctx.runMutation(internal.backgroundJobs.update, {
        jobId: a.jobId, ...(patch.detail ? { detail: patch.detail } : {}), ...(patch.status ? { status: patch.status } : {}), ...(patch.error ? { error: patch.error } : {}),
        phases: [{ key: "rows", label: "Rows", status: patch.status ?? "processing", ...(patch.total !== undefined ? { done: patch.done ?? 0, total: patch.total } : {}) }],
      });
    try {
      const plan = await planFile(ctx, a);
      const client = clientFor(ctx);
      const total = plan.outcomes.length;
      const t = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
      const firstFailures: string[] = [];
      const fail = (row: number, message: string) => {
        t.failed++;
        if (firstFailures.length < 5) firstFailures.push(`row ${row}: ${message}`);
      };
      const tally = (out: Tally) => {
        t.created += out.created;
        t.updated += out.updated;
        t.unchanged += out.unchanged;
        for (const f of out.failed) fail(f.row, f.message);
      };
      for (const o of plan.outcomes) if (o.kind === "skip") t.skipped++; else if (o.kind === "error") t.failed++;
      const detail = () => `${t.created.toLocaleString("en-US")} created · ${t.updated.toLocaleString("en-US")} updated · ${t.unchanged.toLocaleString("en-US")} unchanged · ${t.skipped} skipped · ${t.failed} failed`;
      const started = Date.now();

      const newCompanies = await createCompanies(ctx, client, a, plan);
      // A row's company id: null when it names none, undefined when the company it creates did not reach the register.
      const companyIdOf = (link: CompanyLink | null) => (!link ? null : link.kind === "linked" ? link.companyId : newCompanies.get(link.cell));
      let done = plan.outcomes.filter((o) => o.kind === "skip" || o.kind === "error").length;
      let written = 0;

      if (plan.object === "deal") {
        const rows: DealRow[] = [];
        for (const o of plan.outcomes) {
          if (o.kind !== "create" && o.kind !== "update") continue;
          const companyId = companyIdOf(o.company);
          if (companyId === undefined) {
            fail(o.row, "The new company is not in the register yet");
            done++;
            continue;
          }
          const vals = factValues(o.values);
          const owner = { ...(o.ownerId ? { ownerId: o.ownerId } : {}), ...(o.columns ? { columns: o.columns } : {}) };
          rows.push(o.kind === "create" ? { kind: "create", row: o.row, values: vals, companyId, ...owner } : { kind: "update", row: o.row, values: vals, companyId, dealId: o.match.dealId, ...owner });
        }
        const membersOf = new Map(plan.outcomes.flatMap((o) => ((o.kind === "create" || o.kind === "update") && o.members ? [[o.row, o.members] as const] : [])));
        for (let i = 0; i < rows.length; i += WRITE_BATCH) {
          const batch = rows.slice(i, i + WRITE_BATCH);
          const out = await ctx.runMutation(internal.csvImports.writeDeals, { orgId: a.orgId, userId: a.userId, importId: plan.importId, rows: batch });
          tally(out);
          // The people on a deal's Contacts cell, in their roles, once its stream exists.
          const people = out.streams.flatMap((s) => (membersOf.get(s.row)?.length ? [{ row: s.row, streamId: s.streamId, members: [...membersOf.get(s.row)!] }] : []));
          if (people.length) for (const f of (await ctx.runMutation(internal.csvImports.writeDealMembers, { orgId: a.orgId, userId: a.userId, rows: people })).failed) fail(f.row, f.message);
          done += batch.length;
          written += batch.length;
          await update({ detail: detail(), done, total });
        }
      } else if (plan.object === "records") {
        const creates = plan.outcomes.filter((o): o is Extract<RecordOutcome, { kind: "create" }> => o.kind === "create");
        for (let i = 0; i < creates.length; i += RECORD_BATCH) {
          const batch = creates.slice(i, i + RECORD_BATCH);
          tally(await ctx.runMutation(internal.csvImports.writeRecords, {
            orgId: a.orgId, userId: a.userId, importId: plan.importId,
            rows: batch.map((o) => ({
              row: o.row, object: o.object, createdAt: o.createdAt, targets: o.targets,
              values: Object.fromEntries(Object.entries(o.values).map(([k, x]) => [k, typeof x === "object" && x !== null ? [...x] : x])),
            })),
          }));
          done += batch.length;
          written += batch.length;
          await update({ detail: detail(), done, total });
        }
      } else {
        const object = plan.object;
        const writes = plan.outcomes.filter((o): o is Extract<RowOutcome, { kind: "create" | "update" }> => o.kind === "create" || o.kind === "update");
        const failedRows = new Set<number>();
        for (let i = 0; i < writes.length; i += WRITE_BATCH) {
          const chunk = writes.slice(i, i + WRITE_BATCH);
          const failed = failedRows;
          await resubmitUnprocessed(chunk.map((o): ImportWrite => (o.kind === "create" ? { kind: "create", row: o.row, key: o.key, values: o.values } : { kind: "update", row: o.row, key: o.key, values: o.values, match: o.match })), async (rows) => {
            const out = await ctx.runMutation(internal.csvImports.writeBatch, { orgId: a.orgId, userId: a.userId, object, importId: plan.importId, rows: rows.map(wire) });
            tally(out);
            for (const f of out.failed) failed.add(f.row);
            const left = new Set(out.unprocessed);
            done += rows.length - left.size;
            return rows.filter((r) => left.has(r.row));
          });
          written += chunk.length;
          // The register links a person to a company with its accountId, found by email (contacts/upsert never touches ledger-owned fields).
          // A row with a Companies column links through edges instead, once its person is in the register (below).
          const links = chunk.flatMap((o) => {
            const accountId = companyIdOf(o.company);
            if (failed.has(o.row) || !o.key || !accountId || o.links?.length) return [];
            const name = o.values.fullName;
            return [{ accountId, email: o.key, fullName: typeof name === "string" && name ? name : o.key }];
          });
          if (links.length) await client.upsertContacts(a.orgId, { records: links, source: "csv", idempotencyKey: `csv:${plan.importId}:links:${i}` });
          await update({ detail: detail(), done, total });
        }
        if (object === "contact") await linkCompanies(ctx, client, a, writes, failedRows, companyIdOf, fail);
      }
      const seconds = (Date.now() - started) / 1000;
      console.log(`csv import ${plan.importId}: ${written} rows written in ${seconds.toFixed(1)} s (${Math.round(written / Math.max(seconds, 0.001))} rows/s)`);
      await update({ detail: `${detail()}${firstFailures.length ? `. ${firstFailures.join("; ")}` : ""}`, status: "completed", done: total, total });
      await ctx.runMutation(internal.csvImports.releaseUpload, { storageId: a.storageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await update({ detail: "The import stopped", status: "failed", error: message.slice(0, 500) });
    }
  },
});

/** Write up to WRITE_BATCH planned company or person rows. Rows past the transaction's read budget come back to resubmit. */
export const writeBatch = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), object: partyArg, importId: v.string(), rows: v.array(writeRow) },
  handler: async (ctx, a) => {
    const s = partyStores(ctx);
    const out = { created: 0, updated: 0, unchanged: 0, failed: [] as Array<{ row: number; message: string }>, unprocessed: [] as number[] };
    const { unprocessed } = await syncPartyBatch(a.rows, {
      hasBudget: () => partySyncHasBudget(ctx),
      visit: async (row) => {
        const outcome: ImportWrite = row.kind === "create" ? row : { ...row, match: { ...row.match, snapshot: row.match.snapshot as ImportMatch["snapshot"] } };
        // A register row's stream must be this org's record of this object; otherwise the row is found by its identity.
        const linked = row.kind === "update" && row.match.stream ? ctx.db.normalizeId("canonEntities", row.match.stream) : null;
        const entity = linked ? await ctx.db.get(linked) : null;
        const streamId = entity && entity.orgId === a.orgId && entity.entityType === a.object ? entity._id : undefined;
        const res = await writeImportRow(s, { orgId: a.orgId, object: a.object, importId: a.importId, actorId: a.userId, now: Date.now(), outcome, ...(streamId ? { streamId } : {}) });
        const problems = res.result.status === "invalid" ? res.result.errors : res.rejected;
        if (problems.length) out.failed.push({ row: row.row, message: problems.map((p) => p.message).join("; ") });
        else if (res.result.status === "unchanged") out.unchanged++;
        else out[row.kind === "create" ? "created" : "updated"]++;
      },
    });
    out.unprocessed = unprocessed.map((r) => r.row);
    return out;
  },
});

/**
 * Write up to WRITE_BATCH planned deal rows as their importer, through the
 * deal save path: a new deal as deals.create makes one (owned by the
 * importer), a matched one as a record edit changes it.
 */
export const writeDeals = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), importId: v.string(), rows: v.array(dealRow) },
  handler: async (ctx, a): Promise<Tally & { streams: Array<{ row: number; streamId: string }> }> => {
    const out: Tally & { streams: Array<{ row: number; streamId: string }> } = { created: 0, updated: 0, unchanged: 0, failed: [], streams: [] };
    const pipelines = await orgPipelines(ctx, a.orgId);
    for (const row of a.rows) {
      const source = { kind: "csv", ref: `csv:${a.importId}:${row.row}`, actorId: a.userId } as const;
      // The Owner cell's member, checked again here: still in this workspace.
      const ownerId = row.ownerId ? ctx.db.normalizeId("users", row.ownerId) : null;
      const owner = ownerId ? await ctx.db.get(ownerId) : null;
      if (row.ownerId && (!owner || owner.orgId !== a.orgId)) {
        out.failed.push({ row: row.row, message: "The deal's owner is no longer a member of this workspace" });
        continue;
      }
      const vals: Record<string, FactValue> = { ...row.values, ...(row.companyId ? { companyId: row.companyId } : {}), ...(owner ? { ownerId: owner._id } : {}) };
      let res;
      if (row.kind === "create") {
        const plan = planDealCreate(pipelines, dealCreateInput(row.values, row.columns));
        if (!plan.ok) {
          out.failed.push({ row: row.row, message: plan.error });
          continue;
        }
        res = await insertDeal(ctx, { orgId: a.orgId, repId: owner?._id ?? a.userId, plan, values: { ...vals, ...plan.deal }, source });
        // Revenue type went in with the plan; contract length and products go on the new row.
        const { contractLengthMonths, products } = row.columns ?? {};
        if (contractLengthMonths !== undefined || products) await ctx.db.patch(res.dealId, { ...(contractLengthMonths !== undefined ? { contractLengthMonths } : {}), ...(products ? { products } : {}) });
      } else {
        const dealId = ctx.db.normalizeId("deals", row.dealId);
        const deal = dealId ? await ctx.db.get(dealId) : null;
        if (!deal || deal.orgId !== a.orgId) {
          out.failed.push({ row: row.row, message: "Deal not found" });
          continue;
        }
        res = await saveDealEdit(ctx, deal, source, vals);
        // The row's own columns change on the row; a change to one alone still counts as an update.
        const changed = Object.fromEntries(Object.entries(row.columns ?? {}).filter(([k, x]) => JSON.stringify(deal[k as keyof typeof deal]) !== JSON.stringify(x)));
        if (Object.keys(changed).length) {
          await ctx.db.patch(deal._id, { ...changed, updatedAt: Date.now() });
          if (res.result.status === "unchanged") res = { ...res, result: { ...res.result, status: "applied" } } as typeof res;
        }
      }
      const problems = res.result.status === "invalid" ? res.result.errors : res.rejected;
      if (problems.length) out.failed.push({ row: row.row, message: problems.map((p) => p.message).join("; ") });
      else {
        out.streams.push({ row: row.row, streamId: res.entityId });
        if (res.result.status === "unchanged") out.unchanged++;
        else out[row.kind === "create" ? "created" : "updated"]++;
      }
    }
    return out;
  },
});

/** Put the people a deal's Contacts cell names on the deals just written, in their roles (`deal_contact` edges). */
export const writeDealMembers = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"),
    rows: v.array(v.object({ row: v.number(), streamId: v.string(), members: v.array(v.object({ contactId: v.string(), role: v.string() })) })),
  },
  handler: async (ctx, a) => {
    const failed: Array<{ row: number; message: string }> = [];
    for (const r of a.rows) {
      const res = await setDealRoles(ctx, a.orgId, a.userId, r.streamId, r.members as Array<{ contactId: string; role: DealRole }>);
      if (res.error) failed.push({ row: r.row, message: res.error });
    }
    return { failed };
  },
});

/** Link people to their companies with `contact_account` edges, as the person's page does (see `linkCompanies`). */
export const writeCompanyLinks = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"),
    rows: v.array(v.object({ row: v.number(), contactId: v.string(), seed: v.optional(v.string()), companyIds: v.array(v.string()) })),
  },
  handler: async (ctx, a) => {
    const store = edgeStore(ctx);
    // The person's own edit: it ranks as the user's, so an import never loses a primary flag to an older value.
    const edgeCtx = { orgId: a.orgId, source: { kind: "user" as const, ref: `user:${a.userId}` }, actor: { kind: "user" as const, id: a.userId }, now: Date.now() };
    const failed: Array<{ row: number; message: string }> = [];
    for (const r of a.rows) {
      for (const toId of r.companyIds) {
        const res = await applyEdgeCommand(store, edgeCtx, { op: "link", fromId: r.contactId, toId }, r.seed);
        if (res.status === "invalid") {
          failed.push({ row: r.row, message: res.message });
          break;
        }
      }
    }
    return { failed };
  },
});

/**
 * Write up to RECORD_BATCH planned rows of leads, products, activities or any other registry object, through the object
 * API's `save`: a row is created with its original `createdAt`, found again on a re-run by its file row (external id
 * `csv:<importId>:<object>` / row) and then saved over itself, which changes nothing. An activity then gets an
 * `activity_target` edge to each record it is about.
 */
export const writeRecords = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), importId: v.string(),
    rows: v.array(v.object({ row: v.number(), object: v.string(), values, createdAt: v.union(v.number(), v.null()), targets: v.array(v.string()) })),
  },
  handler: async (ctx, a): Promise<Tally> => {
    const out: Tally = { created: 0, updated: 0, unchanged: 0, failed: [] };
    const store = convexObjectStore(ctx);
    const edges = edgeStore(ctx);
    const defs = new Map<string, ResolvedObjectDef>();
    const fail = (row: number, message: string) => out.failed.push({ row, message });
    for (const r of a.rows) {
      if (!isRecordObject(r.object) && !isActivityObject(r.object)) {
        fail(r.row, `${r.object} cannot be imported`);
        continue;
      }
      let def = defs.get(r.object);
      if (!def) defs.set(r.object, def = await loadDef(ctx, a.orgId, r.object as StandardObjectName));
      const now = Date.now();
      const provider = `csv:${a.importId}:${r.object}`;
      const saveCtx: SaveContext = {
        orgId: a.orgId, def, source: { kind: "import", ref: `csv:${a.importId}:${r.row}` }, actor: { kind: "user", id: a.userId }, now,
        alwaysKeepHotRow: def.residency === "all",
      };
      const found = await store.findByExternalId(a.orgId, provider, String(r.row));
      const cmd: SaveCommand = found
        ? { op: "update", streamId: found, values: r.values }
        : { op: "create", values: r.values, externalId: { provider, externalId: String(r.row) }, ...(r.createdAt !== null ? { createdAt: r.createdAt } : {}) };
      const res = await save(store, saveCtx, cmd);
      if (res.status === "invalid") {
        fail(r.row, res.errors.map((e) => e.message).join("; "));
        continue;
      }
      if (res.status === "conflict") {
        fail(r.row, "The record changed while it was imported");
        continue;
      }
      let changed = res.status !== "unchanged";
      if (r.targets.length) {
        const edgeCtx = { orgId: a.orgId, source: { kind: "user" as const, ref: `user:${a.userId}` }, actor: { kind: "user" as const, id: a.userId }, now };
        const edge = await applyEdgeCommand(edges, edgeCtx, { op: "target", activityId: res.streamId, toIds: r.targets });
        if (edge.status === "invalid") {
          fail(r.row, edge.message);
          continue;
        }
        changed ||= edge.status === "applied";
      }
      if (!changed) out.unchanged++;
      else out[found ? "updated" : "created"]++;
    }
    return out;
  },
});
