/**
 * The Canon side of the Salesforce import (CP11): what the import writes
 * into Canon's own tables rather than the record service. Each function is
 * one Convex transaction over a small batch the import action sends
 * (engine/src/sync/salesforceImport, `CanonSink`), and each converges:
 * re-sending a batch writes nothing new.
 *
 * Opportunities become deals keyed by their Salesforce id, through the deal
 * save path, so the ledger records them from source `salesforce` (which
 * validation rules let through, as for every CRM write). Sales processes
 * become pipelines. Contact roles become `deal_contact` edges, and account
 * parents `account_parent` edges (the sync sends parent changes here too).
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { readDealDef, saveDealValues } from "./canon";
import { NOT_WRITTEN } from "./lib/syncUnchanged";
import { edgeStore } from "./associations";
import { ACTIVITY_TARGETS_MAX, applyEdgeCommand, EDGES_PER_RECORD_MAX, edgesFromSourceNotIn, seedDealRoles } from "./lib/objects/associations";
import { save } from "./lib/objects/write";
import { loadDef } from "./objects";
import { normalizeSfId } from "../engine/src/sync/salesforceImport/mapping.ts";
import { DEAL_ROLES, RegistryError, resolveObjectDef, STANDARD_OBJECTS, type OrgObjectExtension, type PicklistOption } from "./lib/objects/registry";
import { addField, updateField } from "./lib/objects/fieldBuilder";
import { fromStored, toStored } from "./lib/objects/validators";
import { foldAll, project, type LedgerEntry } from "./lib/objects/fold";
import { FORECAST_CATEGORIES, planImportedPipelines, stageOf, type Pipeline } from "./lib/pipelines";
import { orgPipelines } from "./pipelines";
import type { DealValues } from "./lib/canon/dealLedger";

/** Imported activities' external ids: one Salesforce id space for tasks, events, notes and documents. */
const ACTIVITY_PROVIDER = "salesforce:activity";

const forecastCategory = v.union(...FORECAST_CATEGORIES.map((c) => v.literal(c)));
const role = v.union(...DEAL_ROLES.map((r) => v.literal(r)));

const customValue = v.union(v.string(), v.number(), v.boolean(), v.array(v.string()), v.null());

export const dealImport = v.object({
  sfId: v.string(),
  name: v.string(),
  amount: v.optional(v.number()),
  currency: v.string(),
  closeDate: v.string(),
  stage: v.string(),
  forecastCategory,
  probability: v.number(),
  isClosed: v.boolean(),
  isWon: v.boolean(),
  dealType: v.union(v.literal("new_business"), v.literal("expansion"), v.literal("renewal"), v.literal("one_time")),
  revenueType: v.union(v.literal("one_time"), v.literal("recurring")),
  ownerSfId: v.optional(v.string()),
  memberId: v.optional(v.string()),
  accountSfId: v.optional(v.string()),
  createdAt: v.optional(v.number()),
  modifiedAt: v.optional(v.number()),
  nextStep: v.optional(v.string()),
  custom: v.optional(v.record(v.string(), customValue)),
  history: v.optional(v.array(v.object({ at: v.number(), values: v.record(v.string(), customValue) }))),
});

export const dealRoles = v.object({
  opportunitySfId: v.string(),
  roles: v.array(v.object({ roleSfId: v.string(), contactSfId: v.string(), role, createdAt: v.optional(v.number()) })),
});

export const processValidator = v.object({
  name: v.string(),
  recordTypeIds: v.array(v.string()),
  stages: v.array(v.object({ name: v.string(), probability: v.number(), forecastCategory })),
});

async function canonIdOf(ctx: MutationCtx, orgId: Id<"organizations">, sfId: string): Promise<string | null> {
  const row = await ctx.db.query("sfImportIds").withIndex("by_orgId_and_sfId", (q) => q.eq("orgId", orgId).eq("sfId", sfId)).first();
  return row?.canonId ?? null;
}

async function rememberId(ctx: MutationCtx, orgId: Id<"organizations">, object: string, sfId: string, canonId: string) {
  const row = await ctx.db.query("sfImportIds").withIndex("by_orgId_and_sfId", (q) => q.eq("orgId", orgId).eq("sfId", sfId)).first();
  if (!row) await ctx.db.insert("sfImportIds", { orgId, sfId, object, canonId });
  else if (row.canonId !== canonId || row.object !== object) await ctx.db.patch(row._id, { object, canonId });
}

export const membersByEmail = internalQuery({
  args: { orgId: v.id("organizations"), emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ email: string; memberId: string }> = [];
    for (const email of args.emails) {
      const user = await ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", args.orgId).eq("email", email)).first();
      if (user) out.push({ email, memberId: user._id });
    }
    return out;
  },
});

export const rememberIds = internalMutation({
  args: { orgId: v.id("organizations"), object: v.string(), pairs: v.array(v.object({ sfId: v.string(), canonId: v.string() })) },
  handler: async (ctx, args) => {
    for (const p of args.pairs) await rememberId(ctx, args.orgId, args.object, p.sfId, p.canonId);
    return null;
  },
});

const CUSTOM_TYPES = ["text", "number", "currency", "date", "checkbox", "picklist", "multipicklist", "emails", "phones", "links"] as const;
const optionsOf = (f: { type: string } & object): PicklistOption[] => ("options" in f && Array.isArray(f.options) ? (f.options as PicklistOption[]) : []);

const customFieldSpec = v.object({
  sfName: v.string(), label: v.string(),
  type: v.union(...CUSTOM_TYPES.map((t) => v.literal(t))),
  options: v.optional(v.array(v.string())),
});

/**
 * Each Salesforce custom field as a custom field of the Canon object (CP7a's
 * builder rules), matched to an existing field by label, so a re-import adds
 * nothing. A matched picklist gains the Salesforce values it lacks. Returns
 * where each lands and its picklist values' Canon option values.
 */
export const prepareCustomFields = internalMutation({
  args: { orgId: v.id("organizations"), object: v.literal("deal"), specs: v.array(customFieldSpec) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", args.orgId).eq("apiName", args.object)).unique();
    let ext: OrgObjectExtension | undefined = row ? fromStored<OrgObjectExtension>(row) : undefined;
    const before = JSON.stringify(ext ?? null);
    const placements = [];
    for (const spec of args.specs) {
      let field = (ext?.customFields ?? []).find((f) => f.archivedAt === undefined && f.label.toLowerCase() === spec.label.toLowerCase());
      try {
        if (!field) {
          const added = addField(args.object, ext, { label: spec.label, type: spec.type, ...(spec.options ? { options: spec.options.map((label) => ({ label })) } : {}) });
          ext = added.ext;
          field = added.field;
        } else if (spec.options) {
          const current = optionsOf(field);
          const missing = spec.options.filter((label) => !current.some((o) => o.label === label));
          if (missing.length) {
            const fieldId = field.fieldId;
            ext = updateField(args.object, ext, fieldId, { options: [...current.map((o) => ({ value: o.value, label: o.label })), ...missing.map((label) => ({ label }))] });
            field = ext.customFields.find((f) => f.fieldId === fieldId)!;
          }
        }
      } catch (e) {
        // A label that clashes with a standard field, or past the field limit: the values stay in Salesforce, and the field is left out.
        if (e instanceof RegistryError) continue;
        throw e;
      }
      placements.push({ sfName: spec.sfName, apiName: field.apiName, type: spec.type, options: optionsOf(field).map((o) => ({ label: o.label, value: o.value })) });
    }
    if (ext && JSON.stringify(ext) !== before) {
      const doc = {
        registryVersion: ext.registryVersion, customFields: toStored(ext.customFields), updatedAt: Date.now(),
        ...(ext.picklistOptions ? { picklistOptions: toStored(ext.picklistOptions) } : {}),
      };
      if (row) await ctx.db.patch(row._id, doc);
      else await ctx.db.insert("objectDefs", { orgId: args.orgId, apiName: args.object, ...doc });
    }
    return placements;
  },
});

/** Store a pipeline per sales process (planImportedPipelines) and say where each stage lands. */
export const preparePipelines = internalMutation({
  args: { orgId: v.id("organizations"), processes: v.array(processValidator) },
  handler: async (ctx, args) => {
    const { row, ext } = await readDealDef(ctx, args.orgId);
    const field = resolveObjectDef(STANDARD_OBJECTS.deal, ext).byApiName.get("stage");
    const options = field && "options" in field ? field.options : [];
    const rows = await ctx.db.query("dealPipelines").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(100);
    const stored = rows.map((r) => ({ id: r._id as string, name: r.name, stages: r.stages, createdAt: r.createdAt }));
    const plan = planImportedPipelines(options, stored, args.processes);
    if (plan.options.length !== options.length) {
      const picklistOptions = toStored({ ...ext?.picklistOptions, stage: plan.options });
      if (row) await ctx.db.patch(row._id, { picklistOptions, updatedAt: Date.now() });
      else await ctx.db.insert("objectDefs", { orgId: args.orgId, apiName: "deal", registryVersion: 0, customFields: [], picklistOptions, updatedAt: Date.now() });
    }
    let createdAt = Date.now();
    for (const w of plan.writes) {
      if (w.kind === "insert") await ctx.db.insert("dealPipelines", { orgId: args.orgId, name: w.name, stages: w.stages, createdAt: createdAt++ });
      else await ctx.db.patch(w.id as Id<"dealPipelines">, { stages: w.stages });
    }
    return plan.placements;
  },
});

/**
 * Opportunities as deals, by Salesforce id: a new one is inserted with its
 * Salesforce creation time, an existing one (an earlier import or sync) is
 * updated. The owner is the member the owner's email matched; an unmapped
 * owner leaves the deal's rep as it was and keeps the Salesforce owner id.
 */
export const upsertDeals = internalMutation({
  args: { orgId: v.id("organizations"), instanceUrl: v.string(), deals: v.array(dealImport) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const out = { created: 0, updated: 0, rejected: [] as Array<{ index: number; reason: string }> };
    for (const [index, d] of args.deals.entries()) {
      const memberId = d.memberId ? ctx.db.normalizeId("users", d.memberId) : null;
      const member = memberId ? await ctx.db.get(memberId) : null;
      const rep = member && member.orgId === args.orgId ? member._id : undefined;
      const companyId = d.accountSfId ? await canonIdOf(ctx, args.orgId, d.accountSfId) : null;
      const values: DealValues = {
        name: d.name, amount: d.amount ?? null, currency: d.currency, closeDate: d.closeDate, stage: d.stage, forecastCategory: d.forecastCategory,
        probability: d.probability, isClosed: d.isClosed, isWon: d.isWon, dealType: d.dealType, crmOwnerId: d.ownerSfId ?? null,
        // A cleared AccountId or NextStep clears Canon's; an account that did not import leaves the company as it was.
        ...(d.accountSfId === undefined ? { companyId: null } : companyId ? { companyId } : {}), nextStep: d.nextStep ?? null,
        ...d.custom,
      } as DealValues;
      const columns = {
        revenueType: d.revenueType, crmProvider: "salesforce", crmUrl: `${args.instanceUrl.replace(/\/$/, "")}/lightning/r/Opportunity/${d.sfId}/view`,
        closedAt: d.isClosed && Number.isFinite(Date.parse(d.closeDate)) ? Date.parse(d.closeDate) : undefined, lastSyncAt: now,
        ...(rep ? { primaryRepId: rep } : {}), ...(d.createdAt ? { createdAt: d.createdAt } : {}),
      };
      const source = { kind: "salesforce" as const, crmId: d.sfId, ...(d.modifiedAt ? { rawData: { SystemModstamp: d.modifiedAt } } : {}) };
      const existing = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", d.sfId)).first();
      let deal: Doc<"deals"> | null;
      if (existing) {
        // A deal a sync prepared and never wrote is archived until written (lib/syncUnchanged.ts NOT_WRITTEN): this write makes it live.
        const prepared = existing.lastSyncAt === NOT_WRITTEN && existing.archivedAt !== undefined;
        await ctx.db.patch(existing._id, { ...columns, ...(prepared ? { archivedAt: undefined } : {}) });
        deal = await ctx.db.get(existing._id);
      } else {
        const dealId = await ctx.db.insert("deals", {
          orgId: args.orgId, crmId: d.sfId, name: d.name, amount: d.amount, currency: d.currency, closeDate: d.closeDate, dealType: d.dealType,
          stage: d.stage, forecastCategory: d.forecastCategory, probability: d.probability, isClosed: d.isClosed, isWon: d.isWon,
          crmOwnerId: d.ownerSfId, ...(companyId ? { companyId } : {}), ...columns, createdAt: d.createdAt ?? now, updatedAt: now,
        });
        deal = await ctx.db.get(dealId);
      }
      if (!deal) continue;
      // A new deal's history goes in first, so its record history reads in order; on an existing deal a re-import's points are already seen and change nothing.
      const history = async (first: boolean) => {
        for (const [k, point] of (d.history ?? []).entries()) {
          await saveDealValues(ctx, deal, { kind: "salesforce", crmId: d.sfId, history: true, rawData: { SystemModstamp: point.at } }, point.values as DealValues, {
            now: point.at, ...(first && k === 0 ? { creates: true as const } : {}),
          });
        }
      };
      if (!existing) await history(true);
      const saved = await saveDealValues(ctx, deal, source, values, { now, ...(existing || d.history?.length ? {} : { creates: true as const }) });
      if (existing) await history(false);
      if (saved.result.status === "invalid") {
        out.rejected.push({ index, reason: saved.result.errors.map((e) => e.message).join("; ").slice(0, 300) });
        continue;
      }
      await rememberId(ctx, args.orgId, "Opportunity", d.sfId, saved.entityId);
      if (existing) out.updated++;
      else out.created++;
    }
    return out;
  },
});

/**
 * What Canon holds for these opportunities, for the spot check
 * (scripts/sf-spot-check.ts): each deal as the Deals page shows it, its
 * stage's label and pipeline, its owner's email, and its people's roles.
 */
export const dealsForSpotCheck = internalQuery({
  args: { orgId: v.id("organizations"), sfIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const pipelines = await orgPipelines(ctx, args.orgId);
    const out = [];
    for (const sfId of args.sfIds.slice(0, 100)) {
      const deal = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", sfId)).first();
      if (!deal) { out.push({ sfId, found: false as const }); continue; }
      const owner = deal.primaryRepId ? await ctx.db.get(deal.primaryRepId) : null;
      const placed = deal.stage ? stageOf(pipelines, deal.stage) : null;
      const stream = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", args.orgId).eq("projectionId", deal._id)).first();
      const edges = stream
        ? await ctx.db.query("associations").withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", args.orgId).eq("association", "deal_contact").eq("fromId", stream._id)).take(200)
        : [];
      out.push({
        sfId, found: true as const,
        deal: {
          name: deal.name, amount: deal.amount ?? null, currency: deal.currency, closeDate: deal.closeDate, stageLabel: placed?.stage.label ?? deal.stage ?? null,
          pipeline: placed?.pipeline.name ?? null, probability: deal.probability ?? null, forecastCategory: deal.forecastCategory ?? null, isClosed: deal.isClosed,
          isWon: deal.isWon, ownerEmail: owner?.email ?? null, crmOwnerId: deal.crmOwnerId ?? null, companyId: deal.companyId ?? null, createdAt: deal.createdAt,
        },
        roles: edges.filter((e) => e.active).map((e) => ({ contactId: e.toId, label: e.label ?? null })),
        ...(stream ? await dealLedgerView(ctx, args.orgId, stream._id, sfId, pipelines) : { custom: {}, stageHistory: [] }),
      });
    }
    return out;
  },
});

export const activityImport = v.object({
  sfId: v.string(),
  object: v.union(v.literal("task"), v.literal("call"), v.literal("meeting"), v.literal("note")),
  values: v.record(v.string(), v.union(v.string(), v.number(), v.null())),
  ownerSfId: v.optional(v.string()),
  targetSfIds: v.array(v.string()),
  createdAt: v.optional(v.number()),
  modifiedAt: v.optional(v.number()),
});

/** The Canon object a target id names: a register id carries its prefix; a deal's is a stream id. */
const lookupFor = (id: string) => (id.startsWith("acc_") ? "accountId" : id.startsWith("con_") ? "contactId" : "dealId");

/**
 * Tasks, calls, meetings and notes by Salesforce id (CP11b): a new one is
 * created dated when Salesforce created it, a known one updated through the
 * write rule. Its first company, person and deal fill the activity's lookups,
 * as a logged activity's do (activityTargets.ts), and every target Canon has
 * gets an `activity_target` edge. A target that did not import is left out.
 */
export const upsertActivities = internalMutation({
  args: { orgId: v.id("organizations"), rows: v.array(activityImport) },
  handler: async (ctx, args) => {
    const store = edgeStore(ctx);
    const out = { created: 0, updated: 0, rejected: [] as Array<{ index: number; reason: string }> };
    const defs = new Map<string, Awaited<ReturnType<typeof loadDef>>>();
    for (const [index, a] of args.rows.entries()) {
      const def = defs.get(a.object) ?? (await loadDef(ctx, args.orgId, a.object));
      defs.set(a.object, def);
      const targets: string[] = [];
      for (const sfId of a.targetSfIds) {
        const id = await canonIdOf(ctx, args.orgId, sfId);
        if (id && !targets.includes(id)) targets.push(id);
      }
      // Every lookup is asserted, null when Salesforce no longer names one, so a re-import that moved the activity clears it.
      const lookups: Record<string, string | null> = { accountId: null, contactId: null, dealId: null };
      for (const id of [...targets].reverse()) lookups[lookupFor(id)] = id;
      const values: Record<string, unknown> = { ...a.values, ...lookups };
      const ownerId = typeof values.ownerId === "string" ? ctx.db.normalizeId("users", values.ownerId) : null;
      const owner = ownerId ? await ctx.db.get(ownerId) : null;
      if (owner?.orgId !== args.orgId) values.ownerId = null;
      const now = Date.now();
      const saveCtx = { orgId: args.orgId, def, source: { kind: "salesforce" as const, ref: `salesforce:${a.sfId}` }, actor: { kind: "integration" as const, id: "salesforce" }, now };
      // One store for the saves and the edges: it caches the shard heads its appends bump.
      const existing = await store.findByExternalId(args.orgId, ACTIVITY_PROVIDER, a.sfId);
      const result = await save(store, saveCtx, existing
        ? { op: "update", streamId: existing, values, ...(a.modifiedAt ? { validFrom: a.modifiedAt } : {}) }
        : { op: "create", values, externalId: { provider: ACTIVITY_PROVIDER, externalId: a.sfId }, ...(a.createdAt ? { createdAt: a.createdAt } : {}), ...(a.modifiedAt ? { validFrom: a.modifiedAt } : {}) });
      if (result.status === "invalid" || result.status === "conflict") {
        out.rejected.push({ index, reason: result.status === "invalid" ? result.errors.map((e) => `${e.field}: ${e.message}`).join("; ").slice(0, 300) : "version conflict" });
        continue;
      }
      const kept = targets.slice(0, ACTIVITY_TARGETS_MAX);
      const edgeCtx = { orgId: args.orgId, source: saveCtx.source, actor: saveCtx.actor, now: a.createdAt ?? now };
      if (kept.length) {
        const edges = await applyEdgeCommand(store, edgeCtx, { op: "target", activityId: result.streamId, toIds: kept });
        if (edges.status === "invalid") { out.rejected.push({ index, reason: edges.message }); continue; }
      }
      const stale = await edgesFromSourceNotIn(store, args.orgId, "activity_target", result.streamId, kept, "salesforce");
      if (stale.length) await applyEdgeCommand(store, edgeCtx, { op: "untarget", activityId: result.streamId, toIds: stale });
      await rememberId(ctx, args.orgId, a.object, a.sfId, result.streamId);
      if (existing) out.updated++;
      else out.created++;
    }
    return out;
  },
});

/** What Canon holds for these imported activities, for the spot check: each one's object, values, created time and targets. */
export const activitiesForSpotCheck = internalQuery({
  args: { orgId: v.id("organizations"), sfIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out = [];
    for (const sfId of args.sfIds.slice(0, 100)) {
      const ext = await ctx.db.query("canonExternalIds")
        .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", args.orgId).eq("provider", ACTIVITY_PROVIDER).eq("externalId", sfId)).first();
      const entity = ext ? await ctx.db.get(ext.entityId) : null;
      if (!entity) { out.push({ sfId, found: false as const }); continue; }
      const entries = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id)).take(200);
      const state = foldAll(entries.map((e) => ({ streamId: e.streamId, version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor, body: fromStored<LedgerEntry["body"]>(e.body) })));
      const row = state ? project(await loadDef(ctx, args.orgId, entity.entityType), state) : null;
      const edges = await ctx.db.query("associations")
        .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", args.orgId).eq("association", "activity_target").eq("fromId", entity._id)).take(20);
      const owner = typeof row?.values.ownerId === "string" ? await ctx.db.get(row.values.ownerId as Id<"users">) : null;
      out.push({
        sfId, found: true as const, object: entity.entityType, values: row?.values ?? {}, createdAt: row?.createdAt ?? null, ownerEmail: owner?.email ?? null,
        targets: edges.filter((e) => e.active).map((e) => e.toId),
      });
    }
    return out;
  },
});

/**
 * A deal's custom field values as their labels show (a picklist's option
 * label), and its imported stage history as (time, stage label), oldest first.
 */
async function dealLedgerView(ctx: QueryCtx, orgId: Id<"organizations">, streamId: Id<"canonEntities">, sfId: string, pipelines: Pipeline[]) {
  const entries = (await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", streamId)).take(1000))
    .map((e): LedgerEntry => ({ streamId: e.streamId, version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor, body: fromStored<LedgerEntry["body"]>(e.body) }));
  const def = await loadDef(ctx, orgId, "deal");
  const state = foldAll(entries);
  const values = state ? project(def, state).values : {};
  const custom: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (!f.apiName.startsWith("custom.")) continue;
    const value = values[f.fieldId] ?? null;
    const label = (v: unknown) => ("options" in f ? f.options.find((o) => o.value === v)?.label ?? v : v);
    custom[f.label] = Array.isArray(value) ? value.map(label) : label(value);
  }
  const stageHistory: Array<{ at: number; stage: string }> = [];
  for (const e of entries) {
    if (e.source.ref !== `salesforce:history:${sfId}` || e.body.kind !== "assert") continue;
    for (const a of e.body.assertions) {
      if (a.fieldId === "stage" && typeof a.value === "string") stageHistory.push({ at: a.validFrom ?? e.observedAt, stage: stageOf(pipelines, a.value)?.stage.label ?? a.value });
    }
  }
  return { custom, stageHistory: stageHistory.sort((x, y) => x.at - y.at) };
}

/**
 * Each account's Salesforce parent as its `account_parent` edge, written by the record pages' parent rule
 * (one parent, no cycles) as Salesforce. An account or parent Canon does not have is skipped: the import links
 * it when the other end lands. A parent named in Salesforce replaces the one in Canon, whoever set it, as the
 * HubSpot import does. A parent cleared in Salesforce removes only an edge Salesforce made; one a person set
 * in Canon (on the company page or by approving a hierarchy move) stays, and so does one another Salesforce
 * account made: several Salesforce accounts can be one Canon company (a shared domain), and one of them having
 * no parent says nothing about the others'. Called by the import and the sync.
 */
export const setAccountParents = internalMutation({
  args: { orgId: v.id("organizations"), links: v.array(v.object({ sfId: v.string(), parentSfId: v.union(v.string(), v.null()) })) },
  handler: async (ctx, args) => {
    const store = edgeStore(ctx);
    const out = { applied: 0, rejected: [] as Array<{ sfId: string; reason: string }> };
    for (const l of args.links) {
      const accountId = await canonIdOf(ctx, args.orgId, normalizeSfId(l.sfId) ?? l.sfId);
      if (!accountId) continue;
      const parentSfId = l.parentSfId === null ? null : normalizeSfId(l.parentSfId) ?? l.parentSfId;
      const edgeCtx = { orgId: args.orgId, source: { kind: "salesforce" as const, ref: `salesforce:${l.sfId}` }, actor: { kind: "integration" as const, id: "salesforce" }, now: Date.now() };
      if (parentSfId === null) {
        if (!(await parentMadeBy(store, args.orgId, accountId, edgeCtx.source.ref))) continue;
        if ((await applyEdgeCommand(store, edgeCtx, { op: "setParent", accountId, parentId: null })).status === "applied") out.applied++;
        continue;
      }
      const parentId = await canonIdOf(ctx, args.orgId, parentSfId);
      if (!parentId) continue;
      if (parentId === accountId) {
        out.rejected.push({ sfId: l.sfId, reason: `Parent ${parentSfId} not linked: it is the same company in Canon` });
        continue;
      }
      const result = await applyEdgeCommand(store, edgeCtx, { op: "setParent", accountId, parentId });
      if (result.status === "invalid") out.rejected.push({ sfId: l.sfId, reason: `Parent ${parentSfId} not linked: ${result.message}` });
      else if (result.status === "applied") out.applied++;
    }
    return out;
  },
});

/**
 * Whether the company's active parent edge was last made active by this source ref (one Salesforce account). An
 * edge stream is restored rather than recreated when a link comes back, so the latest create or restore says who
 * made the link that stands now, not the stream's first entry.
 */
async function parentMadeBy(store: ReturnType<typeof edgeStore>, orgId: string, accountId: string, ref: string): Promise<boolean> {
  const [edge] = (await store.edgesFrom(orgId, "account_parent", accountId, EDGES_PER_RECORD_MAX)).filter((e) => e.active);
  if (!edge) return false;
  const entries = await store.readEntries(edge.streamId, 0, 1000);
  const made = [...entries].reverse().find((e) => e.body.kind === "lifecycle" && (e.body.op === "create" || e.body.op === "restore")) ?? entries[0];
  return made?.source.kind === "salesforce" && made.source.ref === ref;
}

/** Contact roles as `deal_contact` edges, each dated when Salesforce created the role. */
export const setDealRoles = internalMutation({
  args: { orgId: v.id("organizations"), deals: v.array(dealRoles) },
  handler: async (ctx, args) => {
    const store = edgeStore(ctx);
    const out = { applied: 0, rejected: [] as Array<{ sfId: string; reason: string }> };
    for (const d of args.deals) {
      const streamId = await canonIdOf(ctx, args.orgId, d.opportunitySfId);
      const deal = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", d.opportunitySfId)).first();
      if (!streamId || !deal) {
        for (const r of d.roles) out.rejected.push({ sfId: r.roleSfId, reason: `Opportunity ${d.opportunitySfId} was not imported` });
        continue;
      }
      const legacy = await ctx.db.query("dealContacts").withIndex("by_dealId", (q) => q.eq("dealId", deal._id)).take(50);
      await seedDealRoles(store, args.orgId, streamId, legacy.map((r) => ({ contactId: r.contactId, role: r.slot, reason: r.reason ?? null, setBy: r.setBy, at: r.updatedAt })));
      const wanted: string[] = [];
      for (const r of d.roles) {
        const contactId = await canonIdOf(ctx, args.orgId, r.contactSfId);
        if (!contactId) {
          out.rejected.push({ sfId: r.roleSfId, reason: `Contact ${r.contactSfId} was not imported` });
          continue;
        }
        wanted.push(contactId);
        const edgeCtx = { orgId: args.orgId, source: { kind: "salesforce" as const, ref: `salesforce:${r.roleSfId}` }, actor: { kind: "integration" as const, id: "salesforce" }, now: r.createdAt ?? Date.now() };
        const result = await applyEdgeCommand(store, edgeCtx, { op: "setRole", dealId: streamId, contactId, role: r.role });
        if (result.status === "invalid") out.rejected.push({ sfId: r.roleSfId, reason: result.message });
        else out.applied++;
      }
      // A role Salesforce no longer has leaves the deal; people Canon put on it stay.
      const removedCtx = { orgId: args.orgId, source: { kind: "salesforce" as const, ref: `salesforce:${d.opportunitySfId}` }, actor: { kind: "integration" as const, id: "salesforce" }, now: Date.now() };
      for (const contactId of await edgesFromSourceNotIn(store, args.orgId, "deal_contact", streamId, wanted, "salesforce")) {
        await applyEdgeCommand(store, removedCtx, { op: "removeFromDeal", dealId: streamId, contactId });
      }
    }
    return out;
  },
});
