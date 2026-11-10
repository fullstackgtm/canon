/**
 * The object layer's Convex API (docs/cp0-object-layer.md) for the objects
 * the ledger serves so far: lead, task, note, call, meeting and product. Every save goes
 * through `save` in lib/objects/write.ts inside one mutation.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { accessFor, recordVisible, requireWriteAccess, roleIn, sightJudge, workspaceMembers } from "./permissions";
import { admitThenRead } from "./lib/scopedRecordClient";
import { hiddenFields, lockedFields, may, refuseLockedWrite, withoutHidden, type Access, type RecordOp } from "./lib/access";
import { orgObjectDefs, scheduleNudge, shardHeads } from "./ledgerFeed";
import { scheduleDealHistory } from "./dealHistory";
import { scheduleWebhookFanout } from "./recordWebhooks";
import { scheduleAutomationFanout } from "./lib/automationWake";
import { scheduleModuleFeed } from "./lib/modules/jobs";
import { automationRefPrefix, type AutomationMark } from "./lib/automations";
import { callerClient, requireCaller } from "./records";
import { ICP_FIELDS, isRegisterObject, ListRequestError, listRowOf, registerListDef, type ListResponse, type ListRow, type ProjectedThrough, type SearchResponse } from "./lib/objects/listSpec";
import { EDITABLE_ACCOUNT_FIELDS, EDITABLE_CONTACT_FIELDS } from "./lib/recordContract";
import { AGENT_SOURCES } from "./lib/canon/gate";
import { BULK_MAX } from "./lib/objects/views";
import { builderOwns } from "./lib/objects/fieldBuilder";
import { ACTIVITY_OBJECT, activityReportDef } from "./lib/objects/reportSpec";
import { isStandardEditField } from "./lib/canon/partyLedger";
import type { FoldState, LedgerEntry } from "./lib/objects/fold";
import { project, titleOf } from "./lib/objects/fold";
import { indexObjectDef, isCustomObjectName, isLedgerObjectName, plainObjectDef, STANDARD_OBJECTS, type ResolvedObjectDef } from "./lib/objects/registry";
import { archivedObjectNames, loadOrgObject } from "./lib/objects/orgDefs";
import * as objectValidators from "./lib/objects/validators";
import { fromStored, toStored } from "./lib/objects/validators";
import { partySyncHasBudget, saveDealLifecycle } from "./canon";
import { saveDealEdit } from "./deals";
import type { FactValue } from "./lib/canon/policy";
import { coerce } from "./lib/objects/registry";
import { readIcps } from "./lib/icpsInterface";
import { LEDGER_OBJECTS, materialize, save, saveBatch, shardOf, type ObjectReader, type ObjectStore, type SaveCommand, type SaveContext, type SaveResult } from "./lib/objects/write";
import { currentLines, parentDeal } from "./lib/objects/lineItemRecords";
import { lineProblem, lineTotal, MAX_DEAL_LINES, orderedProducts } from "./lib/objects/lineItems";

/** Entries `get` folds for a record with no hot row. */
const GET_FOLD_CAP = 1000;
/** Entries `hotRows` folds per id with no hot row; past it the row is returned marked incomplete. */
const HOT_ROWS_FOLD_CAP = 50;
const MAX_HOT_ROWS = 100;
const MAX_IMPORT_BATCH = 100;
/**
 * Ledger entries one import batch may read before it stops and hands back the
 * rest. Convex allows 32,000 documents read per transaction; each record also
 * reads a handful of index rows, so this leaves room for them.
 */
const IMPORT_ENTRY_READ_BUDGET = 16_000;
const MAX_HISTORY_PAGE = 100;


/**
 * Objects whose records are created, deleted and restored by stream id: the generic standard ones and an org's own
 * custom objects (CP7d). A custom object is checked against the org's registry in `loadDef`; the arg is a plain string
 * because the set differs per org.
 */
const objectValidator = v.string();
const isGenericObject = (o: string) => (LEDGER_OBJECTS as readonly string[]).includes(o) || isCustomObjectName(o);
function requireGeneric(object: string) {
  if (!isGenericObject(object)) throw new ConvexError(`${object} records are not written here`);
}
/**
 * Objects `write` and `bulk` edit: the generic ones, plus deals, which save
 * through their own writer (`saveDealValues`) so the `deals` row and the
 * `facts` mirror stay in step. Deals are created through deals.create; they
 * are archived and restored here, through their own writer too (saveDealLifecycle).
 */
const EDITABLE_OBJECTS = [...LEDGER_OBJECTS, "deal"] as const;
/**
 * Deal fields the generic pages show but do not write: the CRM owner id is the
 * CRM's identity, not a Canon user (owner changes go through ownership.ts), and
 * closed and won follow the forecast category.
 */
const DEAL_READ_ONLY = ["crmOwnerId", "isClosed", "isWon"] as const;
/** Lead fields a conversion sets (convex/leadConversion.ts): shown on the generic pages, never typed or bulk-set there. */
export const LEAD_READ_ONLY = ["convertedAt", "convertedAccountId", "convertedContactId", "convertedDealId"] as const;
function refuseConversionFields(object: string, values: Record<string, unknown> | undefined) {
  if (object === "lead" && values && LEAD_READ_ONLY.some((f) => Object.hasOwn(values, f))) throw new ConvexError("Convert a lead to set these fields");
}
const editableValidator = v.string();
function requireEditable(object: string) {
  if (!(EDITABLE_OBJECTS as readonly string[]).includes(object) && !isCustomObjectName(object)) throw new ConvexError(`${object} records are not written here`);
}
/** Objects whose stream entity carries another name (the `facts` ledger's), and its record page objects. */
const VIEWABLE_ENTITY_TYPES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(LEDGER_OBJECTS.map((o) => [o, o])),
  opportunity: "deal",
};
const inputValues = v.record(v.string(), objectValidators.fieldValue);
const userSource = v.union(v.literal("user"), ...AGENT_SOURCES.map((k) => v.literal(k)));

const saveResult = v.union(
  v.object({ status: v.union(v.literal("applied"), v.literal("proposed")), streamId: v.string(), version: v.number(), shard: v.number(), seq: v.number() }),
  v.object({ status: v.literal("unchanged"), streamId: v.string(), version: v.number() }),
  v.object({ status: v.literal("conflict"), streamId: v.string(), version: v.number(), expectedVersion: v.number() }),
  v.object({ status: v.literal("invalid"), errors: v.array(v.object({ field: v.string(), message: v.string(), rule: v.optional(v.string()) })) }),
);

const recordView = v.object({
  streamId: v.id("canonEntities"),
  object: v.string(),
  version: v.number(),
  title: v.string(),
  values: v.record(v.string(), objectValidators.fieldValue),
  meta: v.record(v.string(), objectValidators.fieldMeta),
  lifecycle: objectValidators.lifecycle,
  createdAt: v.number(),
  updatedAt: v.number(),
  /** False when the record was folded from its stream because it has no hot row. */
  hot: v.boolean(),
  /** False when the stream was longer than the read's fold cap: the values are as of `version`, not current. */
  complete: v.boolean(),
});

/** An object's definition for the org: a standard object with its custom fields, or one of the org's own objects. */
export async function loadDef(ctx: QueryCtx, orgId: Id<"organizations">, object: string): Promise<ResolvedObjectDef> {
  const def = await loadOrgObject(ctx, orgId, object);
  if (!def) throw new ConvexError(`Unknown object ${object}`);
  return def;
}

export const asEntry = (e: Doc<"ledgerEntries">): LedgerEntry => ({
  streamId: e.streamId, version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor, body: fromStored<LedgerEntry["body"]>(e.body),
});

export const asState = (row: Doc<"recordRows">): FoldState => ({
  streamId: row.streamId, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, lifecycle: row.lifecycle,
  fields: fromStored<FoldState["fields"]>(row.fields),
  watermarks: fromStored<FoldState["watermarks"]>(row.watermarks ?? []),
});

/** `reads.entries` counts ledger entries read, so a batch can stop before Convex's read limit. */
function readStore(ctx: QueryCtx, hotRowIds = new Map<string, Id<"recordRows">>(), reads = { entries: 0 }): ObjectReader {
  return {
    async getStream(streamId) {
      const entity = await ctx.db.get(streamId as Id<"canonEntities">);
      // Deal entities predate the registry and keep the `facts` ledger's name for them.
      return entity ? { orgId: entity.orgId, object: entity.entityType === "opportunity" ? "deal" : entity.entityType } : null;
    },
    async getHotRow(streamId) {
      const entity = await ctx.db.get(streamId as Id<"canonEntities">);
      if (!entity) return null;
      const row = await ctx.db.query("recordRows")
        .withIndex("by_orgId_streamId", (q) => q.eq("orgId", entity.orgId).eq("streamId", entity._id))
        .unique();
      if (row) hotRowIds.set(streamId, row._id);
      return row ? asState(row) : null;
    },
    async readEntries(streamId, afterVersion, limit) {
      const rows = await ctx.db.query("ledgerEntries")
        .withIndex("by_streamId_version", (q) => q.eq("streamId", streamId as Id<"canonEntities">).gt("version", afterVersion))
        .take(limit);
      reads.entries += rows.length;
      return rows.map(asEntry);
    },
  };
}

/** A record's name for a refusal that says who holds a value: its hot row's title, else its entity's label. */
export async function recordLabel(ctx: QueryCtx, streamId: string): Promise<string | null> {
  const id = ctx.db.normalizeId("canonEntities", streamId);
  const entity = id && (await ctx.db.get(id));
  if (!entity) return null;
  const row = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", entity.orgId).eq("streamId", entity._id)).unique();
  return row?.title || entity.label || null;
}

export function convexObjectStore(ctx: MutationCtx, reads = { entries: 0 }): ObjectStore {
  const hotRowIds = new Map<string, Id<"recordRows">>();
  const heads = new Map<number, { _id: Id<"ledgerShardHeads">; seq: number }>();
  const org = (id: string) => id as Id<"organizations">;
  return {
    ...readStore(ctx, hotRowIds, reads),
    async createStream(orgId, object, label) {
      const id = await ctx.db.insert("canonEntities", {
        orgId: org(orgId), entityType: object, projectionTable: "recordRows", projectionId: "", createdAt: Date.now(),
        ...(label ? { label: label.slice(0, 200) } : {}),
      });
      await ctx.db.patch(id, { projectionId: id });
      return id;
    },
    async findByExternalId(orgId, provider, externalId) {
      const row = await ctx.db.query("canonExternalIds")
        .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", org(orgId)).eq("provider", provider).eq("externalId", externalId))
        .first();
      return row?.entityId ?? null;
    },
    async addExternalId(orgId, streamId, provider, externalId) {
      await ctx.db.insert("canonExternalIds", { orgId: org(orgId), entityId: streamId as Id<"canonEntities">, provider, externalId });
    },
    labelOf: (streamId) => recordLabel(ctx, streamId),
    async removeExternalId(orgId, streamId, provider, externalId) {
      const row = await ctx.db.query("canonExternalIds")
        .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", org(orgId)).eq("provider", provider).eq("externalId", externalId))
        .first();
      if (row && row.entityId === streamId) await ctx.db.delete(row._id);
    },
    async externalIdsOf(streamId, limit) {
      const rows = await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", streamId as Id<"canonEntities">)).take(limit);
      return rows.map((r) => ({ provider: r.provider, externalId: r.externalId }));
    },
    async nextSeq(orgId, shard) {
      let head = heads.get(shard);
      if (!head) {
        const row = await ctx.db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", org(orgId)).eq("shard", shard)).unique();
        head = row ? { _id: row._id, seq: row.seq } : { _id: await ctx.db.insert("ledgerShardHeads", { orgId: org(orgId), shard, seq: 0 }), seq: 0 };
      }
      head = { ...head, seq: head.seq + 1 };
      heads.set(shard, head);
      await ctx.db.patch(head._id, { seq: head.seq });
      return head.seq;
    },
    async appendEntry(orgId, e) {
      await ctx.db.insert("ledgerEntries", {
        orgId: org(orgId), streamId: e.streamId as Id<"canonEntities">, object: e.object, shard: e.shard, seq: e.seq,
        version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor, body: toStored(e.body),
      });
      await scheduleNudge(ctx, org(orgId));
      await scheduleWebhookFanout(ctx, org(orgId));
      await scheduleAutomationFanout(ctx, org(orgId));
      await scheduleModuleFeed(ctx, org(orgId));
      if (e.object === "deal") await scheduleDealHistory(ctx, org(orgId));
    },
    async putHotRow(orgId, def, state, row, now) {
      const doc = {
        orgId: org(orgId), streamId: state.streamId as Id<"canonEntities">, object: def.apiName, version: state.version,
        registryVersion: def.registryVersion, title: titleOf(def, row), values: toStored(row.values), meta: row.meta,
        lifecycle: state.lifecycle, fields: toStored(state.fields), watermarks: toStored(state.watermarks), createdAt: state.createdAt, updatedAt: state.updatedAt,
        lastReadAt: now,
        ...(def.apiName === "lineItem" ? { parentStreamId: row.values.dealId as Id<"canonEntities"> } : {}),
      };
      const existing = hotRowIds.get(state.streamId);
      if (existing) await ctx.db.replace(existing, doc);
      else hotRowIds.set(state.streamId, await ctx.db.insert("recordRows", doc));
    },
    async addProposal(orgId, p) {
      await ctx.db.insert("proposalQueue", { orgId: org(orgId), streamId: p.streamId as Id<"canonEntities">, object: p.object, fieldId: p.fieldId, factId: p.factId, observedAt: p.observedAt });
    },
    async removeProposal(orgId, factId) {
      const row = await ctx.db.query("proposalQueue").withIndex("by_orgId_factId", (q) => q.eq("orgId", org(orgId)).eq("factId", factId)).first();
      if (row) await ctx.db.delete(row._id);
    },
    async survivorOf(streamId) {
      const id = ctx.db.normalizeId("canonEntities", streamId);
      return (id && (await ctx.db.get(id))?.mergedInto) ?? null;
    },
  };
}

type Caller = Doc<"users">;

/** `automation`: a rule saves as its creator (convex/automations.ts), under its own source record. */
type SaveOpts = { sourceKind?: "user" | (typeof AGENT_SOURCES)[number]; evidence?: string; confidence?: number; automation?: AutomationMark; moduleProposal?: { module: string; plan: Id<"patchPlans"> } };

async function userSaveContext(ctx: MutationCtx, user: Caller, object: string, opts: SaveOpts = {}): Promise<SaveContext> {
  const kind = opts.sourceKind ?? "user";
  const prefix = opts.moduleProposal ? `module:${opts.moduleProposal.module}:plan:${opts.moduleProposal.plan}:` : opts.automation ? automationRefPrefix(opts.automation) : "";
  const def = await loadDef(ctx, user.orgId, object);
  if (def.archivedAt !== undefined) throw new ConvexError(`${def.pluralLabel} is archived; restore it in Customization, Data model to change its records`);
  return {
    orgId: user.orgId,
    def,
    // One source record per user: the write rule compares a user's save with that user's last value.
    source: { kind, ref: prefix + (kind === "user" ? `user:${user._id}` : `${kind}:user:${user._id}`) },
    actor: { kind: "user", id: user._id },
    now: Date.now(),
    ...(opts.evidence !== undefined ? { evidence: opts.evidence.slice(0, 4000) } : {}),
    ...(opts.confidence !== undefined ? { confidence: Math.min(1, Math.max(0, opts.confidence)) } : {}),
  };
}

export async function saveAsCaller(ctx: MutationCtx, user: Caller, object: string, cmd: SaveCommand, opts: SaveOpts = {}): Promise<SaveResult> {
  if (object === "lineItem") {
    const existing = cmd.op !== "create" ? await view(ctx, user.orgId, cmd.streamId as Id<"canonEntities">, GET_FOLD_CAP, new Map()) : null;
    const parent = cmd.op === "create" ? cmd.values.dealId : existing?.values.dealId;
    const deal = typeof parent === "string" ? ctx.db.normalizeId("canonEntities", parent) : null;
    if (!deal) throw new ConvexError("Line item or deal not found");
    return (await saveDealLinesAsCaller(ctx, user, deal, [cmd], opts))[0];
  }
  return save(convexObjectStore(ctx), await userSaveContext(ctx, user, object, opts), cmd);
}

const LINE_INPUT_FIELDS = ["dealId", "productId", "quantity", "unitPrice", "totalPrice", "position"];

/** One transaction for single-record edits and whole-list replacement; validate the final set, never an intermediate total. */
export async function saveDealLinesAsCaller(ctx: MutationCtx, user: Caller, dealId: Id<"canonEntities">, commands: readonly SaveCommand[], opts: SaveOpts = {}): Promise<SaveResult[]> {
  if (opts.sourceKind && opts.sourceKind !== "user") throw new ConvexError("Line-item proposals are not available yet");
  if (opts.automation) throw new ConvexError("Change line items with an explicit version check");
  const access = await requireWriteAccess(ctx, user);
  if (!can(user, "deals.write") || !may(access, "deal", "edit") || !may(access, "lineItem", "read")) throw new ConvexError("Your role cannot change deal line items");
  const deal = await parentDeal(ctx, user.orgId, access, dealId);
  if (!deal) throw new ConvexError("Deal not found");
  if (commands.length > MAX_DEAL_LINES * 2) throw new ConvexError("Too many line-item changes");
  const store = convexObjectStore(ctx);
  const context = await userSaveContext(ctx, user, "lineItem", opts);
  const seen = new Set<string>();
  const results: SaveResult[] = [];
  for (const cmd of commands) {
    if (cmd.op !== "create" && cmd.op !== "update" && cmd.op !== "delete" && cmd.op !== "restore") throw new ConvexError("This line-item operation is not available");
    const op = cmd.op === "create" ? "create" : cmd.op === "update" ? "edit" : "delete";
    if (!may(access, "lineItem", op)) throw new ConvexError(`Your role cannot ${op} line items`);
    const existing = cmd.op === "create" ? null : await view(ctx, user.orgId, cmd.streamId as Id<"canonEntities">, GET_FOLD_CAP, new Map());
    if (cmd.op !== "create") {
      if (!existing || existing.object !== "lineItem" || !existing.complete || existing.values.dealId !== dealId) throw new ConvexError("Line item not found");
      if (seen.has(cmd.streamId)) throw new ConvexError("Change each line item once");
      seen.add(cmd.streamId);
      if (cmd.expectedVersion === undefined || !Number.isSafeInteger(cmd.expectedVersion) || cmd.expectedVersion < 0) throw new ConvexError("A line-item change needs its expectedVersion");
    }
    let normalized = cmd;
    if (cmd.op === "create" || cmd.op === "update" || cmd.op === "restore") {
      const input = cmd.op === "create" || cmd.op === "update" ? cmd.values : {};
      if (Object.keys(input).some((field) => !LINE_INPUT_FIELDS.includes(field))) throw new ConvexError("Only product, quantity, prices and position are edited here");
      refuseLockedWrite(access, "lineItem", Object.keys(input));
      const values = { ...existing?.values, ...input };
      if (values.dealId !== dealId) throw new ConvexError("A line item cannot move to another deal");
      const problem = lineProblem({ quantity: values.quantity as number, unitPrice: values.unitPrice as number | null, totalPrice: values.totalPrice as number });
      if (problem) throw new ConvexError(problem);
      if (values.position != null && (!Number.isSafeInteger(values.position) || Number(values.position) < 0)) throw new ConvexError("Position must be a nonnegative integer");
      // A saved name is a snapshot: quantity edits do not rename existing lines after a catalog change.
      if (!existing || values.productId !== existing.values.productId || cmd.op === "restore") {
        const productId = typeof values.productId === "string" ? ctx.db.normalizeId("canonEntities", values.productId) : null;
        const product = productId ? await view(ctx, user.orgId, productId, GET_FOLD_CAP, new Map()) : null;
        if (!may(access, "product", "read") || hiddenFields(access, "product").includes("name") || !product || product.object !== "product" || !product.complete || product.lifecycle.status !== "active" || product.values.active === false) throw new ConvexError("Choose an active product in this workspace");
        if (cmd.op === "create" || cmd.op === "update") {
          refuseLockedWrite(access, "lineItem", ["name", "source"]);
          normalized = { ...cmd, values: { ...input, name: String(product.values.name ?? product.title), source: "manual" } };
        }
      }
    }
    const result = await save(store, context, normalized);
    // A structured conflict is safe for a single command; a replacement must roll every earlier write back.
    if (result.status !== "applied" && result.status !== "unchanged") {
      if (commands.length === 1) return [result];
      throw new ConvexError("Line items changed or could not be saved");
    }
    results.push(result);
  }
  const rows = await currentLines(ctx, user.orgId, dealId);
  lineTotal(rows.map((row) => ({ totalPrice: row.values.totalPrice as number })));
  await ctx.db.patch(deal._id, { lineItemProducts: rows.length ? orderedProducts(rows.map((row) => ({ id: row.streamId, name: String(row.values.name ?? ""), position: Number(row.values.position ?? 0) }))) : undefined });
  return results;
}

/**
 * A person's edit of a deal from a list or record page: the deal's own writer
 * appends to its stream, mirrors `facts` and patches the `deals` row. Like the
 * Deals page, only admins and managers edit deals. A stage sets its
 * pipeline's probability and forecast category, and the category sets closed
 * and won (lib/pipelines.ts withStageOutcome). `expectedVersion` is checked against the hot
 * row, as `save` checks it.
 */
export async function saveDealAsCaller(
  ctx: MutationCtx, user: Caller, streamId: Id<"canonEntities">, values: Record<string, unknown>, expectedVersion?: number, automation?: AutomationMark,
): Promise<SaveResult> {
  if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));
  const entity = await ctx.db.get(streamId);
  const dealId = entity && entity.orgId === user.orgId && entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  if (!deal) return { status: "invalid", errors: [{ field: "streamId", message: "Deal not found" }] };
  const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", user.orgId).eq("streamId", streamId)).unique();
  const version = hot?.version ?? (Object.hasOwn(values, "splitAllocations") ? (await view(ctx, user.orgId, streamId, GET_FOLD_CAP, new Map()))?.version ?? 0 : null);
  if (expectedVersion !== undefined && version !== null && version !== expectedVersion) {
    return { status: "conflict", streamId, version, expectedVersion };
  }
  const def = await loadDef(ctx, user.orgId, "deal");
  const readOnly = Object.keys(values).filter((k) => (DEAL_READ_ONLY as readonly string[]).includes(k));
  if (readOnly.length) return { status: "invalid", errors: readOnly.map((field) => ({ field, message: `${def.byApiName.get(field)?.label ?? field} is not edited here` })) };
  const coerced = coerce(def, values, { mode: "update" });
  if (!coerced.ok) return { status: "invalid", errors: coerced.errors };
  const edited: Record<string, FactValue> = Object.fromEntries(coerced.values.map((c) => [def.byFieldId.get(c.fieldId)!.apiName, c.value as FactValue]));
  // The owner is a member of this workspace, as New deal requires.
  if (typeof edited.ownerId === "string") {
    const ownerKey = ctx.db.normalizeId("users", edited.ownerId);
    const owner = ownerKey ? await ctx.db.get(ownerKey) : null;
    if (!owner || owner.orgId !== user.orgId) return { status: "invalid", errors: [{ field: "ownerId", message: "That owner is not in this workspace" }] };
  }
  if (Object.hasOwn(edited, "splitAllocations")) {
    if (expectedVersion === undefined || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new ConvexError("A credit split edit needs its expectedVersion");
    const splits = edited.splitAllocations;
    if (Array.isArray(splits)) for (const split of splits) {
      const id = ctx.db.normalizeId("users", split.userId);
      const member = id ? await ctx.db.get(id) : null;
      if (!member || member.isHidden || !(await roleIn(ctx, member, user.orgId))) return { status: "invalid", errors: [{ field: "splitAllocations", message: "Choose active members of this workspace for credit splits" }] };
    }
  }
  const { result, rejected } = await saveDealEdit(ctx, deal, { kind: "user", userId: user._id, ...(automation ? { automation } : {}) }, edited);
  if (rejected.length && result.status !== "applied") return { status: "invalid", errors: rejected };
  if (result.status !== "deferred") return result;
  // Written to `facts` only: this deal's history waits for a later transaction to convert. Nothing for the projector to pass.
  const after = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", user.orgId).eq("streamId", streamId)).unique();
  return { status: "applied", streamId, version: after?.version ?? 0, shard: shardOf(streamId), seq: 0 };
}

/**
 * Create a record (no `streamId`) or change its fields. An agent-class
 * `sourceKind` lands the values as proposals for review.
 */
export const write = mutation({
  args: {
    object: editableValidator,
    streamId: v.optional(v.id("canonEntities")),
    values: inputValues,
    expectedVersion: v.optional(v.number()),
    sourceKind: v.optional(userSource),
    evidence: v.optional(v.string()),
    confidence: v.optional(v.number()),
  },
  returns: saveResult,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    requireEditable(args.object);
    refuseConversionFields(args.object, args.values);
    await requireWritable(ctx, user, await requireWriteAccess(ctx, user), args.object, args.streamId ? "edit" : "create", args.streamId, args.values);
    if (args.object === "deal") {
      if (!args.streamId) throw new ConvexError("Create deals with deals.create");
      if (args.sourceKind && args.sourceKind !== "user") throw new ConvexError("Agents propose deal values through the fact gate");
      return saveDealAsCaller(ctx, user, args.streamId, args.values, args.expectedVersion);
    }
    const cmd: SaveCommand = args.streamId
      ? { op: "update", streamId: args.streamId, values: args.values, ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}) }
      : { op: "create", values: args.values };
    return saveAsCaller(ctx, user, args.object, cmd, args);
  },
});

const lifecycleArgs = { object: objectValidator, streamId: v.id("canonEntities"), expectedVersion: v.optional(v.number()) };

async function lifecycle(ctx: MutationCtx, args: { object: string; streamId: Id<"canonEntities">; expectedVersion?: number }, op: "delete" | "restore") {
  if (args.object !== "deal") requireGeneric(args.object);
  const user = await requireUser(ctx);
  await requireWritable(ctx, user, await requireWriteAccess(ctx, user), args.object, "delete", args.streamId);
  if (args.object === "deal") return archiveDealAsCaller(ctx, user, args.streamId, op, args.expectedVersion);
  return saveAsCaller(ctx, user, args.object, { op, streamId: args.streamId, expectedVersion: args.expectedVersion });
}

/** Archive or restore a deal, as deals are edited: by admins and managers. */
async function archiveDealAsCaller(ctx: MutationCtx, user: Caller, streamId: Id<"canonEntities">, op: "delete" | "restore", expectedVersion?: number): Promise<SaveResult> {
  if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));
  const entity = await ctx.db.get(streamId);
  const dealId = entity && entity.orgId === user.orgId && entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  if (!deal) return { status: "invalid", errors: [{ field: "streamId", message: "Deal not found" }] };
  return saveDealLifecycle(ctx, deal, op, user._id, expectedVersion);
}

export const remove = mutation({
  args: lifecycleArgs,
  returns: saveResult,
  handler: (ctx, args) => lifecycle(ctx, args, "delete"),
});

export const restore = mutation({
  args: lifecycleArgs,
  returns: saveResult,
  handler: (ctx, args) => lifecycle(ctx, args, "restore"),
});

/**
 * Save one change to up to BULK_MAX records of an object: set `values` on
 * each, delete them, or restore them. Each record gets its own result; a
 * record past the read budget comes back in `unprocessed` to resend.
 */
export const bulk = mutation({
  args: {
    object: editableValidator,
    op: v.union(v.literal("update"), v.literal("delete"), v.literal("restore")),
    streamIds: v.array(v.id("canonEntities")),
    values: v.optional(inputValues),
  },
  returns: v.object({
    results: v.array(v.object({ streamId: v.id("canonEntities"), result: saveResult })),
    unprocessed: v.array(v.id("canonEntities")),
  }),
  handler: async (ctx, args) => {
    if (args.streamIds.length > BULK_MAX) throw new ConvexError(`Save at most ${BULK_MAX} records at a time`);
    if (args.object === "lineItem") throw new ConvexError("Change line items individually with expectedVersion, or from their deal's Products section");
    if (args.object === "deal" && args.op === "update" && Object.hasOwn(args.values ?? {}, "splitAllocations")) throw new ConvexError("Change credit splits on one deal with its expectedVersion");
    if (args.op === "update" && !args.values) throw new ConvexError("An update needs values");
    const user = await requireUser(ctx);
    requireEditable(args.object);
    refuseConversionFields(args.object, args.values);
    const access = await requireWriteAccess(ctx, user);
    const op = args.op === "update" ? "edit" : "delete";
    // Every record must be one the caller may change: the whole batch is refused otherwise, as a hidden record must not be touched.
    for (const streamId of new Set(args.streamIds)) await requireWritable(ctx, user, access, args.object, op, streamId, args.values);
    if (args.object === "deal") {
      const results = [];
      const unprocessed = [];
      for (const streamId of new Set(args.streamIds)) {
        // Each changed field re-resolves from up to 200 facts: stop at the shared facts-read budget and hand the rest back.
        if (results.length > 0 && !partySyncHasBudget(ctx)) unprocessed.push(streamId);
        else results.push({ streamId, result: args.op === "update" ? await saveDealAsCaller(ctx, user, streamId, args.values!) : await archiveDealAsCaller(ctx, user, streamId, args.op) });
      }
      return { results, unprocessed };
    }
    const reads = { entries: 0 };
    const change = args.op === "update" ? { op: "update" as const, values: args.values! } : { op: args.op };
    // Same budget as importBatch: a record without a hot row folds its stream.
    return saveBatch(convexObjectStore(ctx, reads), await userSaveContext(ctx, user, args.object), change, args.streamIds, () => reads.entries >= IMPORT_ENTRY_READ_BUDGET);
  },
});

/** Rows one `createMany` call creates: each is a ledger entry, and a CSV import sends them one call after another. */
export const CREATE_MANY_MAX = 25;

/**
 * Create up to CREATE_MANY_MAX records of a custom object in one call, for a CSV import: each row is checked against the
 * registry as a form save is, and a row that fails comes back `invalid` without stopping the others.
 */
export const createMany = mutation({
  args: { object: v.string(), rows: v.array(inputValues) },
  returns: v.array(saveResult),
  handler: async (ctx, args) => {
    if (!isCustomObjectName(args.object)) throw new ConvexError("CSV import is open to custom objects here; companies, people and deals import from their own pages");
    if (args.rows.length > CREATE_MANY_MAX) throw new ConvexError(`Create at most ${CREATE_MANY_MAX} records at a time`);
    const user = await requireUser(ctx);
    await requireWritable(ctx, user, await requireWriteAccess(ctx, user), args.object, "create", undefined, Object.assign({}, ...args.rows));
    const saveCtx = await userSaveContext(ctx, user, args.object, {});
    const store = convexObjectStore(ctx);
    const out = [];
    for (const values of args.rows) out.push(await save(store, saveCtx, { op: "create", values }));
    return out;
  },
});

export async function view(ctx: QueryCtx, orgId: Id<"organizations">, streamId: Id<"canonEntities">, cap: number, defs: Map<string, ResolvedObjectDef>) {
  const entity = await ctx.db.get(streamId);
  const object = !entity ? null : Object.hasOwn(VIEWABLE_ENTITY_TYPES, entity.entityType) ? VIEWABLE_ENTITY_TYPES[entity.entityType] : isCustomObjectName(entity.entityType) ? entity.entityType : null;
  if (!entity || entity.orgId !== orgId || !object) return null;
  const record = await materialize(readStore(ctx), streamId, cap);
  if (!record) return null;
  let def = defs.get(object);
  if (!def) defs.set(object, (def = await loadDef(ctx, orgId, object)));
  const row = project(def, record.state);
  // A deal's owner is its row's `primaryRepId` (lib/canon/dealLedger.ts); a CRM import sets it without a ledger fact.
  if (object === "deal" && entity.projectionTable === "deals") {
    const dealId = ctx.db.normalizeId("deals", entity.projectionId);
    const deal = dealId ? await ctx.db.get(dealId) : null;
    if ((row.values.ownerId ?? null) === null && deal?.primaryRepId) row.values.ownerId = deal.primaryRepId;
    if (!row.meta.splitAllocations?.factId && deal?.splitAllocations) row.values.splitAllocations = deal.splitAllocations.map((s) => ({ ...s, kind: s.kind ?? "revenue" }));
  }
  return {
    streamId, object, version: record.state.version, title: titleOf(def, row), values: toStored(row.values), meta: row.meta,
    lifecycle: record.state.lifecycle, createdAt: row.createdAt, updatedAt: row.updatedAt, hot: record.hot, complete: record.complete,
  };
}

/**
 * The record a write names, if the caller may `op` it: their role allows the
 * operation on the object and they see the record. Refuses otherwise, the
 * same way whether the record is hidden or missing, so a write cannot probe
 * for records the caller cannot see.
 */
export async function requireWritable(
  ctx: MutationCtx, user: Caller, access: Access, object: string, op: RecordOp, streamId?: Id<"canonEntities">, values?: Record<string, unknown>,
) {
  if (!may(access, object, op)) throw new ConvexError(`Your role cannot ${op} ${object} records`);
  // A field hidden or read-only for the caller's role is not set by them (CP14).
  if (values) refuseLockedWrite(access, object, Object.keys(values));
  if (!streamId) return;
  const record = await view(ctx, user.orgId, streamId, GET_FOLD_CAP, new Map());
  if (record && !(await recordVisible(ctx, access, record))) throw new ConvexError("Record not found");
}

/** Whether `access` sees a record by its stream (an automation rule's principal, convex/automations.ts): missing reads as not seen. */
export async function recordVisibleTo(ctx: QueryCtx, access: Access, orgId: Id<"organizations">, streamId: Id<"canonEntities">): Promise<boolean> {
  const record = await view(ctx, orgId, streamId, GET_FOLD_CAP, new Map());
  return record !== null && (await recordVisible(ctx, access, record));
}

/** A viewed record without the fields hidden from the caller's role (CP14): values and meta are keyed by fieldId, which is the apiName. */
function forCaller<R extends { object: string; values: Record<string, unknown>; meta: Record<string, unknown> }>(access: Access, record: R): R {
  return { ...record, ...(record.object === "lineItem" && hiddenFields(access, "lineItem").includes("name") ? { title: "" } : {}), values: withoutHidden(access, record.object, record.values), meta: withoutHidden(access, record.object, record.meta) };
}

/** The slugs of the org's AI fields, whose `custom.<slug>` answers come from runs, not edits. */
async function aiFieldSlugs(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Set<string>> {
  const agents = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).take(50);
  return new Set(agents.map((a) => a.slug));
}

/** An object's definition for list views and record pages: its fields in order, and what the caller may do with its records there. */
export const describe = query({
  args: { object: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const object = args.object;
    const access = user ? await accessFor(ctx, user) : null;
    // What the caller's role allows on the object (CP14); a page offers only that.
    const allows = (op: RecordOp) => access !== null && may(access, object, op);
    const hiddenSet = new Set(access ? hiddenFields(access, object) : []);
    const locked = access ? lockedFields(access, object).filter((f) => !hiddenSet.has(f)) : [];
    // Activities are a report-only object (lib/objects/reportSpec.ts): described for the report builder, never listed or edited.
    if (user && object === ACTIVITY_OBJECT) return { ...toStored(plainObjectDef(activityReportDef())), pages: false, register: false, writable: false, canCreate: false, canDelete: false, readOnlyFields: [] as string[] };
    if (!user || !isLedgerObjectName(object)) return null;
    if (isRegisterObject(object)) {
      // Accounts and contacts list from the register, by record-service id; an edit goes through records.edit, which
      // promotes an unworked row onto the ledger, as a delete does (records.bulkRegister). Created on their own pages for now.
      const listed = registerListDef(object, await loadDef(ctx, user.orgId, object));
      // The ICP columns pick from the workspace's saved ICPs, by name.
      const icpOptions = (await readIcps(ctx, user.orgId)).map((i) => ({ value: i.key, label: i.name, active: true }));
      const fields = listed.fields.filter((f) => !hiddenSet.has(f.apiName)).map((f) => (ICP_FIELDS.includes(f.apiName) ? { ...f, options: icpOptions } : f));
      const def = { ...listed, fields, byApiName: new Map(fields.map((f) => [f.apiName, f])), byFieldId: new Map(fields.map((f) => [f.fieldId, f])) };
      const editable: readonly string[] = object === "account" ? EDITABLE_ACCOUNT_FIELDS : EDITABLE_CONTACT_FIELDS;
      // Custom fields are edited through records.edit too, except an AI field's answers, which come from its runs.
      const ai = await aiFieldSlugs(ctx, user.orgId);
      // A formula or rollup field (CP7c) is computed, never edited.
      const mayEdit = (f: { apiName: string; type: string }) => f.type !== "formula" && (editable.includes(f.apiName) || isStandardEditField(object, f.apiName) || builderOwns(f, ai));
      return {
        ...toStored(plainObjectDef(def)), pages: true, register: true, writable: allows("edit"), canCreate: false,
        // Only admins and managers delete and restore, as deals are edited.
        canDelete: can(user, "deals.write") && allows("delete"),
        readOnlyFields: [...def.fields.filter((f) => !f.system && !mayEdit(f)).map((f) => f.apiName), ...locked],
      };
    }
    // An org's own object that does not exist, or is archived, is not there for pages, the API or the tools.
    const loaded = await loadOrgObject(ctx, user.orgId, object);
    if (!loaded || loaded.archivedAt !== undefined) return null;
    // An archived field leaves forms, views and the API; the ledger keeps its values.
    const def = plainObjectDef({ ...loaded, fields: loaded.fields.filter((f) => f.archivedAt === undefined && !hiddenSet.has(f.apiName)) });
    const generic = isGenericObject(object);
    const editable = (EDITABLE_OBJECTS as readonly string[]).includes(object) || isCustomObjectName(object);
    // Deal edits and creates follow the Deals page's rule: admins and managers.
    const mayEdit = object === "lineItem" ? can(user, "deals.write") && allows("read") && access !== null && may(access, "deal", "edit") : object !== "deal" || can(user, "deals.write");
    // `pages`: the generic list and record pages serve it. `writable`: this user may edit its records there.
    return {
      ...toStored(def), pages: editable && object !== "lineItem", register: false, writable: editable && mayEdit && allows("edit"),
      canCreate: (generic || object === "deal") && mayEdit && allows("create"), canDelete: (generic || object === "deal") && mayEdit && allows("delete"),
      readOnlyFields: [...(object === "deal" ? DEAL_READ_ONLY : object === "lead" ? LEAD_READ_ONLY : object === "lineItem" ? def.fields.filter((f) => !LINE_INPUT_FIELDS.includes(f.apiName)).map((f) => f.apiName) : []), ...def.fields.filter((f) => f.type === "formula").map((f) => f.apiName), ...locked],
    };
  },
});

/** A ledger entry's body without hidden fields: assertions about them dropped; null when nothing is left to show. */
function withoutHiddenEntry(body: Record<string, unknown>, hidden: ReadonlySet<string>): Record<string, unknown> | null {
  if (typeof body.fieldId === "string" && hidden.has(body.fieldId)) return null;
  if (!Array.isArray(body.assertions)) return body;
  const assertions = (body.assertions as Array<{ fieldId?: string }>).filter((a) => !a.fieldId || !hidden.has(a.fieldId));
  return assertions.length || !(body.assertions as unknown[]).length ? { ...body, assertions } : null;
}

/** One record: its hot row, else folded from its stream and marked `hot: false`. */
export const get = query({
  args: { streamId: v.id("canonEntities") },
  returns: v.union(recordView, v.null()),
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const record = await view(ctx, user.orgId, args.streamId, GET_FOLD_CAP, new Map());
    // A record the caller's role does not see reads as missing (CP14).
    const access = await accessFor(ctx, user);
    return record && (await recordVisible(ctx, access, record)) ? forCaller(access, record) : null;
  },
});

export const splitMembers = query({
  args: { streamId: v.id("canonEntities") },
  returns: v.array(v.object({ _id: v.id("users"), name: v.string(), isActive: v.literal(true) })),
  handler: async (ctx, { streamId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const access = await accessFor(ctx, user);
    const record = await view(ctx, user.orgId, streamId, GET_FOLD_CAP, new Map());
    if (!record || record.object !== "deal" || hiddenFields(access, "deal").includes("splitAllocations") || !(await recordVisible(ctx, access, record))) return [];
    return (await workspaceMembers(ctx, user.orgId)).map((m) => ({ _id: m.id, name: m.name, isActive: true as const }));
  },
});

/** The current rows for a page of ids (a list view's overlay). Ids outside the caller's org come back null. */
export const hotRows = query({
  args: { streamIds: v.array(v.id("canonEntities")) },
  returns: v.array(v.union(recordView, v.null())),
  handler: async (ctx, args) => {
    if (args.streamIds.length > MAX_HOT_ROWS) throw new ConvexError(`Read at most ${MAX_HOT_ROWS} rows at a time`);
    const user = await getCurrentUser(ctx);
    if (!user) return args.streamIds.map(() => null);
    const defs = new Map<string, ResolvedObjectDef>();
    const access = await accessFor(ctx, user);
    const out = [];
    for (const id of args.streamIds) {
      const record = await view(ctx, user.orgId, id, HOT_ROWS_FOLD_CAP, defs);
      out.push(record && (await recordVisible(ctx, access, record)) ? forCaller(access, record) : null);
    }
    return out;
  },
});

/**
 * The custom fields (`custom.<slug>`) of contact streams, by stream id, for outbound audiences.
 * The register's list rows carry no custom values; the ledger stream does.
 */
export const customFieldValues = internalQuery({
  args: { orgId: v.id("organizations"), streamIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const def = await loadDef(ctx, args.orgId, "contact");
    const custom = def.fields.filter((f) => !f.system && f.type !== "formula" && f.apiName.startsWith("custom."));
    const out: Record<string, Record<string, string | number | boolean>> = {};
    if (!custom.length) return out;
    for (const streamId of args.streamIds) {
      const id = ctx.db.normalizeId("canonEntities", streamId);
      const entity = id && (await ctx.db.get(id));
      if (!id || !entity || entity.orgId !== args.orgId || entity.entityType !== "contact") continue;
      const record = await materialize(readStore(ctx), id, HOT_ROWS_FOLD_CAP);
      if (!record) continue;
      const { values } = project(def, record.state);
      const row: Record<string, string | number | boolean> = {};
      for (const f of custom) {
        const value = values[f.fieldId];
        if (value !== null && value !== undefined && value !== "") row[f.apiName] = Array.isArray(value) ? value.join("; ") : (value as string | number | boolean);
      }
      if (Object.keys(row).length) out[streamId] = row;
    }
    return out;
  },
});

/**
 * The custom fields (`custom.<slug>`) of deals, by deal id and slug, for a module's read plan that grants them
 * (`reads.deals: ["custom"]`, docs/modules.md "Server code"). A deal's custom values live in its ledger stream, not its
 * row; a field `visible` refuses (the caller's role hides it) is left out, and a deal with no stream has none.
 */
export async function dealCustomValues(ctx: QueryCtx, orgId: Id<"organizations">, dealIds: readonly string[], visible: (apiName: string) => boolean): Promise<Record<string, Record<string, unknown>>> {
  const def = await loadDef(ctx, orgId, "deal");
  const custom = def.fields.filter((f) => !f.system && f.type !== "formula" && f.apiName.startsWith("custom.") && visible(f.apiName));
  const out: Record<string, Record<string, unknown>> = {};
  for (const dealId of dealIds) {
    out[dealId] = {};
    if (!custom.length) continue;
    const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", dealId)).first();
    const record = entity ? await materialize(readStore(ctx), entity._id, HOT_ROWS_FOLD_CAP) : null;
    if (!record) continue;
    // A long stream with no hot row folds only so far: refuse rather than show its custom fields as they once were.
    if (!record.complete) throw new ConvexError("A deal's custom fields are still being read into Canon. Try again in a moment.");
    const { values } = project(def, record.state);
    for (const f of custom) {
      const value = values[f.fieldId];
      if (value !== null && value !== undefined && value !== "") out[dealId][f.apiName.slice("custom.".length)] = value;
    }
  }
  return out;
}

/** A record's ledger entries, newest first. */
export const history = query({
  args: { streamId: v.id("canonEntities"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return EMPTY_HISTORY;
    // A company's or person's history for a role that sees only some: historyScoped admits it (the page asks it instead).
    const r = await historyAs(ctx, user, args, new Set());
    return r.pending.length ? EMPTY_HISTORY : r.value;
  },
});

const EMPTY_HISTORY = { page: [], isDone: true, continueCursor: "" };

/**
 * A record's history as `user` may see it (CP14): only a record their role
 * sees (permissions.sightJudge: a deal by its row, a ledger record by its
 * owner, a company or person only once an action admitted it), and without
 * the past values of a field hidden from them.
 */
async function historyAs(ctx: QueryCtx, user: Doc<"users">, args: { streamId: Id<"canonEntities">; paginationOpts: { numItems: number; cursor: string | null } }, admitted: ReadonlySet<string>) {
  const entity = await ctx.db.get(args.streamId);
  if (!entity || entity.orgId !== user.orgId) return { pending: [], value: EMPTY_HISTORY };
  const access = await accessFor(ctx, user);
  const judge = sightJudge(ctx, [access], admitted);
  if (!(await judge.entity(entity))) return { pending: judge.pending, value: EMPTY_HISTORY };
  // A hidden field's past values leave the history too (CP14): its assertions are dropped, and an entry about it alone.
  const hidden = new Set(hiddenFields(access, entity.entityType === "opportunity" ? "deal" : entity.entityType));
  const page = await ctx.db.query("ledgerEntries")
    .withIndex("by_streamId_version", (q) => q.eq("streamId", args.streamId))
    .order("desc")
    .paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, MAX_HISTORY_PAGE) });
  return {
    pending: [],
    value: {
      ...page,
      page: page.page.flatMap((e) => {
        const body = hidden.size ? withoutHiddenEntry(fromStored<Record<string, unknown>>(e.body), hidden) : null;
        if (hidden.size && !body) return [];
        return [{ version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor, body: body ? toStored(body) : e.body, shard: e.shard, seq: e.seq }];
      }),
    },
  };
}

export const historyFor = internalQuery({
  args: { streamId: v.id("canonEntities"), paginationOpts: paginationOptsValidator, admitted: v.array(v.string()) },
  handler: async (ctx, { admitted, ...args }) => {
    const user = await getCurrentUser(ctx);
    return user ? historyAs(ctx, user, args, new Set(admitted)) : { pending: [], value: EMPTY_HISTORY };
  },
});

/** `history` for a role that sees only some companies or people (CP14): the record is admitted through the caller's scoped client. */
export const historyScoped = action({
  args: { streamId: v.id("canonEntities"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof historyAs>>["value"]> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead<Awaited<ReturnType<typeof historyAs>>["value"]>(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.objects.historyFor, { ...args, admitted }));
  },
});

/**
 * Import up to 100 records from one source. A record is keyed by
 * (source ref, externalId): a known one is updated through the write rule, and
 * a row whose `validFrom` is no newer than one already imported is a replay
 * and changes nothing. `createdAt` and `validFrom` are kept from the source.
 */
export const importBatch = internalMutation({
  args: {
    orgId: v.id("organizations"),
    object: objectValidator,
    sourceRef: v.string(),
    actorId: v.string(),
    records: v.array(v.object({
      externalId: v.string(),
      values: inputValues,
      createdAt: v.optional(v.number()),
      validFrom: v.optional(v.number()),
    })),
  },
  returns: v.object({
    results: v.array(v.object({ externalId: v.string(), result: saveResult })),
    /** Records not reached because the batch hit its read budget; resubmit them. */
    unprocessed: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (args.records.length > MAX_IMPORT_BATCH) throw new ConvexError(`Import at most ${MAX_IMPORT_BATCH} records at a time`);
    if (args.object === "lineItem") throw new ConvexError("CRM line-item import is not available yet");
    const reads = { entries: 0 };
    const store = convexObjectStore(ctx, reads);
    const def = await loadDef(ctx, args.orgId, args.object);
    const saveCtx = {
      orgId: args.orgId, def, source: { kind: "import" as const, ref: args.sourceRef }, actor: { kind: "integration" as const, id: args.actorId },
      now: Date.now(), alwaysKeepHotRow: def.residency === "all",
    };
    const provider = `${args.sourceRef}:${args.object}`;
    const results = [];
    const unprocessed: string[] = [];
    for (const r of args.records) {
      if (reads.entries >= IMPORT_ENTRY_READ_BUDGET) {
        unprocessed.push(r.externalId);
        continue;
      }
      const streamId = await store.findByExternalId(args.orgId, provider, r.externalId);
      const cmd: SaveCommand = streamId
        ? { op: "update", streamId, values: r.values, validFrom: r.validFrom }
        : { op: "create", values: r.values, externalId: { provider, externalId: r.externalId }, createdAt: r.createdAt, validFrom: r.validFrom };
      results.push({ externalId: r.externalId, result: await save(store, saveCtx, cmd) });
    }
    return { results, unprocessed };
  },
});

// List views and search (CP1f): served by the record service's projection, or
// by the fake over hot rows when no service is configured (local stacks).

/** A list or search names a standard object or one of the org's own; an org's custom objects differ, so the arg is a string. */
const listedObject = v.string();
function requireListed(object: string) {
  if (!isLedgerObjectName(object)) throw new ConvexError(`Unknown object ${object}`);
}

export async function asListError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ListRequestError) throw new ConvexError(e.message);
    throw e;
  }
}

/**
 * One page of an object's records: filter by any field, sort by any field,
 * keyset `cursor`, `total` on every page, `deleted: true` for the recycle bin.
 * `projectedThrough` is the projector's cursor per shard; a client that just
 * saved re-queries until it passes its save's (shard, seq). Values are keyed by
 * fieldId, like `hotRows`, so the page can be overlaid with live rows.
 */
export const list = action({
  args: {
    object: listedObject,
    filter: v.optional(v.array(objectValidators.listFilter)),
    sort: v.optional(objectValidators.listSort),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    deleted: v.optional(v.boolean()),
  },
  handler: async (ctx, { object, ...req }): Promise<ListResponse> => {
    const caller = await requireCaller(ctx, { read: true });
    requireListed(object);
    if (isCustomObjectName(object) && (await ctx.runQuery(internal.objects.archivedObjects, { orgId: caller.orgId as Id<"organizations"> })).includes(object)) throw new ConvexError(`Unknown object ${object}`);
    // Only the records the caller's role sees (CP14): the caller's client puts the scope on the request, so totals and cursors count those alone.
    const client = callerClient(ctx, caller);
    // Accounts and contacts list from the register, worked or not; `p_account`/`p_contact` hold worked ones only.
    if (isRegisterObject(object)) return asListError(() => client.listRegister(caller.orgId, object, req));
    return asListError(() => client.listObjects(caller.orgId, object, req));
  },
});

/** The caller's org's ledger shard heads, for a nudge sent from an action. */
export const callerShardHeads = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user ? shardHeads(ctx, user.orgId) : {};
  },
});

/**
 * Records whose title contains `q`, across objects: titles that start with it first, then the most recently updated.
 * Accounts and contacts come from the register (record ids, worked or not) and also match on domain or email.
 */
export const search = action({
  args: { q: v.string(), limit: v.optional(v.number()), perObject: v.optional(v.number()), objects: v.optional(v.array(listedObject)) },
  handler: async (ctx, args): Promise<SearchResponse> => {
    const caller = await requireCaller(ctx, { read: true });
    args.objects?.forEach(requireListed);
    // Each object's hits are narrowed to what the caller sees (CP14), in the query, so `limit` counts visible hits.
    const found = await asListError(() => callerClient(ctx, caller).searchObjects(caller.orgId, args));
    // An archived custom object keeps its records and projection, but its records are not found.
    const archived = await ctx.runQuery(internal.objects.archivedObjects, { orgId: caller.orgId as Id<"organizations"> });
    return archived.length ? { ...found, hits: found.hits.filter((h) => !archived.includes(h.object)) } : found;
  },
});

/** The apiNames of the org's archived custom objects. */
export const archivedObjects = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => [...(await archivedObjectNames(ctx, args.orgId))],
});

/** A page of the org's hot rows as list rows, for the fake record client (convex/records.ts convexFakeObjectSource). */
export const fakeObjectRows = internalQuery({
  args: { ws: v.string(), objects: v.union(v.array(v.string()), v.null()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const orgId = ctx.db.normalizeId("organizations", args.ws);
    if (!orgId) return { rows: [], defs: [], heads: {}, isDone: true, continueCursor: "" };
    const plainDefs = await orgObjectDefs(ctx, orgId);
    const defs = new Map(plainDefs.map((d) => [d.apiName, indexObjectDef(d)]));
    const page = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId)).paginate(args.paginationOpts);
    const rows: ListRow[] = [];
    for (const doc of page.page) {
      const def = defs.get(doc.object);
      if (def && (!args.objects || args.objects.includes(doc.object))) rows.push(listRowOf(def, asState(doc)));
    }
    const heads = await ctx.db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId)).take(16);
    return {
      rows: toStored(rows),
      defs: args.paginationOpts.cursor === null ? plainDefs.filter((d) => !args.objects || args.objects.includes(d.apiName)) : [],
      heads: Object.fromEntries(heads.map((h) => [String(h.shard), h.seq])),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
