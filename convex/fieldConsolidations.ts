import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { unrestrictedUser } from "./permissions";
import { can, refusal } from "./lib/capabilities";
import { jobEntry } from "./lib/runs";
import { saveParty, survivorOf } from "./canon";
import { shardOf } from "./lib/objects/write";
import {
  COLUMN_OBJECTS, DEFAULT_POLICY, DISCOVERY_VERSION, MAX_MAP_ENTRIES, SCALE_FACTORS, canonOwnedFields, conceptKeywords, consolidationStatus, destinationFits,
  destinationsOf, fieldDefinition, measureOf, sourceFits, type Column, type ColumnObject, type DecisionKind, type Destination, type FieldDefinition,
  type ObjectProfile,
} from "./lib/consolidate";

/**
 * Field consolidation (docs/field-consolidation.md): the saved setup and its profiles. Reading the CRMs and writing
 * plans happen in fieldConsolidationActions.ts; nothing here touches a CRM.
 *
 * Profiles describe values across the whole portal, so every read and write needs a caller who sees every record and
 * may manage integrations.
 */

async function manager(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await unrestrictedUser(ctx);
  if (!user) throw new ConvexError("Field consolidation needs access to every record in the workspace.");
  if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return user;
}

async function owned(ctx: QueryCtx | MutationCtx, id: Id<"fieldConsolidations">) {
  const user = await manager(ctx);
  const doc = await ctx.db.get(id);
  if (!doc || doc.orgId !== user.orgId) throw new ConvexError("Consolidation not found");
  return { user, doc };
}

const policyValidator = v.object({
  mode: v.union(v.literal("blanks"), v.literal("overwrite")),
  protectedValues: v.array(v.string()),
  minConfidence: v.number(),
  combine: v.optional(v.union(v.literal("first"), v.literal("mean"), v.literal("median"), v.literal("min"), v.literal("max"))),
  tolerance: v.optional(v.number()),
});
const scaleValidator = v.object({ column: v.string(), factor: v.number(), origin: v.union(v.literal("auto"), v.literal("user")) });
const HISTORY = 20;

type RunSection = {
  /** Missing on runs previewed before quantities: a category. */
  measure?: "category" | "quantity";
  /** Missing on runs previewed before destinations: written once approved. Shadow sections are never written. */
  mode?: "off" | "shadow" | "review" | "auto";
  object: ColumnObject;
  system: "hubspot" | "salesforce";
  column: { key: string; label: string; name: string; options: Array<{ label: string; value: string }> };
  read: number;
  total: number | null;
  capped: boolean;
  counts: Record<DecisionKind, number>;
  changes: Array<{ from: string; to: string; count: number }>;
  fills: Array<{ to: string; count: number }>;
  /** Missing on runs previewed before coverage was added. */
  bySource?: Record<string, number>;
  blank?: number;
  samples: Array<{
    kind: DecisionKind; id: string; name: string | null; current: string | null; proposed: string | null;
    column: string | null; raw: string | null; confidence: number | null;
  }>;
};

function runSummary(run: Doc<"fieldConsolidationRuns">) {
  return {
    _id: run._id, status: run.status, error: run.error ?? null, failedDuring: run.failedDuring ?? null, writes: run.writes,
    applied: run.applied ?? null, undone: run.undone ?? null, stored: run.stored ?? null, createdAt: run.createdAt,
    appliedAt: run.appliedAt ?? null, undoneAt: run.undoneAt ?? null, csvRows: run.csvRows ?? null,
  };
}

const writing = (run: Doc<"fieldConsolidationRuns">) => run.status === "applying" || run.status === "undoing";

/** A run that never wrote anything: a preview, kept only until the next one. */
const previewOnly = (run: Doc<"fieldConsolidationRuns">) => run.appliedAt === undefined && run.status !== "applying";

/** Delete a run, its CSV and (in the background, a page at a time) its writes. */
async function dropRun(ctx: MutationCtx, run: Doc<"fieldConsolidationRuns">) {
  if (run.csv) await ctx.storage.delete(run.csv);
  await ctx.db.delete(run._id);
  await ctx.scheduler.runAfter(0, internal.fieldConsolidations.deleteWrites, { runId: run._id });
}

const entryValidator = v.object({
  from: v.string(),
  to: v.union(v.string(), v.null()),
  origin: v.union(v.literal("auto"), v.literal("ai"), v.literal("user")),
  confidence: v.number(),
});

const destinationValidator = v.object({
  column: v.string(),
  mode: v.union(v.literal("off"), v.literal("shadow"), v.literal("review"), v.literal("auto")),
});

/** The workspace's Canon fields, each with the columns it writes, how full the first is and its status. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user || !can(user, "integrations.manage")) return [];
    const rows = await ctx.db.query("fieldConsolidations").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").take(50);
    const out = [];
    for (const r of rows) {
      const columns = (r.columns ?? []) as Column[];
      const writes = destinationsOf(r).filter((d) => d.mode !== "off").flatMap((d) => columns.filter((c) => c.key === d.column));
      const target = writes[0];
      const run = r.run ? await ctx.db.get(r.run) : null;
      let fill: { filled: number; read: number } | null = null;
      if (target) {
        const row = await ctx.db
          .query("fieldConsolidationProfiles")
          .withIndex("by_consolidationId_and_object", (q) => q.eq("consolidationId", r._id).eq("object", target.object))
          .unique();
        const profile = row?.profile as ObjectProfile | undefined;
        const stats = profile?.columns[target.name];
        if (profile && stats) fill = { filled: stats.filled, read: profile.read };
      }
      out.push({
        _id: r._id,
        concept: r.concept,
        destinations: writes.map((c) => ({ label: c.label, name: c.name, object: c.object })),
        fill,
        status: consolidationStatus(r, run),
        updatedAt: r.updatedAt,
      });
    }
    return out;
  },
});

export const get = query({
  args: { id: v.id("fieldConsolidations") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user || !can(user, "integrations.manage")) return null;
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.orgId !== user.orgId) return null;
    const profiles = await ctx.db
      .query("fieldConsolidationProfiles")
      .withIndex("by_consolidationId_and_object", (q) => q.eq("consolidationId", args.id))
      .take(Object.keys(COLUMN_OBJECTS).length);
    const job = doc.job ? await ctx.db.get(doc.job.id) : null;
    const run = doc.run ? await ctx.db.get(doc.run) : null;
    const history = await ctx.db
      .query("fieldConsolidationRuns")
      .withIndex("by_consolidationId_and_createdAt", (q) => q.eq("consolidationId", args.id))
      .order("desc")
      .take(HISTORY);
    const columns = (doc.columns ?? []) as Column[];
    return {
      ...doc,
      status: consolidationStatus(doc, run),
      field: fieldDefinition(doc, columns),
      destinations: destinationsOf(doc),
      columns,
      valueMap: doc.valueMap ?? [],
      scales: doc.scales ?? [],
      policy: doc.policy ?? DEFAULT_POLICY,
      profiles: profiles.map((p) => ({ object: p.object, stage: p.stage, read: p.read, profile: p.profile ?? null, error: p.error ?? null, updatedAt: p.updatedAt })),
      job: job && doc.job ? { task: doc.job.task, startedAt: job.startedAt, error: job.error ?? null, ...jobEntry(job, Date.now()) } : null,
      run: run
        ? {
            ...runSummary(run),
            sections: (run.sections ?? []) as RunSection[],
            csvUrl: run.csv ? await ctx.storage.getUrl(run.csv) : null,
            stale: run.settingsVersion !== (doc.settingsVersion ?? 0),
          }
        : null,
      // Runs that wrote (or are writing) to a CRM, newest first: each can be undone as one unit.
      history: history.filter((r) => r.appliedAt !== undefined || r.status === "applying").map(runSummary),
    };
  },
});

/** Start a consolidation for a concept: discovery reads each connected CRM's column definitions, then profiles them. */
export const create = mutation({
  args: { concept: v.string() },
  handler: async (ctx, args) => {
    const user = await manager(ctx);
    const concept = args.concept.trim();
    const keywords = conceptKeywords(concept);
    if (!keywords.length) throw new ConvexError("Name the concept with at least one word of three letters or more, e.g. industry.");
    const now = Date.now();
    const id = await ctx.db.insert("fieldConsolidations", {
      orgId: user.orgId, createdBy: user._id, concept, keywords, stage: "discovering", updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.fieldConsolidationActions.discover, { id });
    return id;
  },
});

/** Rename a Canon field. Its keywords, columns and setup stay; "Search again" uses the keywords, not the name. */
export const rename = mutation({
  args: { id: v.id("fieldConsolidations"), concept: v.string() },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const concept = args.concept.trim().slice(0, 80);
    if (!concept) throw new ConvexError("Give the field a name.");
    await ctx.db.patch(doc._id, { concept, updatedAt: Date.now() });
    return null;
  },
});

/** Read the columns again, with edited keywords: profiles start over, the target, map and policy stay. */
export const rediscover = mutation({
  args: { id: v.id("fieldConsolidations"), keywords: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const keywords = [...new Set(args.keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 1))].slice(0, 20);
    if (!keywords.length) throw new ConvexError("Keep at least one keyword.");
    await ctx.db.patch(doc._id, { keywords, stage: "discovering", error: undefined, settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.fieldConsolidationActions.discover, { id: doc._id });
    return null;
  },
});

/** The field's definition and destinations as saved fields, so a field set up before destinations keeps its options. */
function definitionPatch(doc: Doc<"fieldConsolidations">, columns: readonly Column[]) {
  if (doc.kind && doc.level) return {};
  const field = fieldDefinition(doc, columns);
  return field ? { kind: field.measure, level: field.level, options: field.options, optionsFrom: doc.target, destinations: destinationsOf(doc) } : {};
}

function checkDestinations(destinations: readonly Destination[], byKey: ReadonlyMap<string, Column>, field: FieldDefinition): Destination[] {
  const out = new Map<string, Destination>();
  for (const d of destinations) {
    const column = byKey.get(d.column);
    if (!column) throw new ConvexError("A destination column isn't part of this field.");
    if (!destinationFits(column, field)) {
      throw new ConvexError(`${column.label} (${COLUMN_OBJECTS[column.object].label}) can't hold this field: a destination is a writable ${field.measure === "quantity" ? "number" : "picklist"} on the same kind of record.`);
    }
    if (d.mode === "auto") throw new ConvexError("Auto writes come with continuous updates. Use Review or Shadow for now.");
    out.set(d.column, d);
  }
  return [...out.values()];
}

function checkSources(sources: readonly string[], byKey: ReadonlyMap<string, Column>, field: FieldDefinition, destinations: readonly Destination[]): string[] {
  const written = new Set(destinations.map((d) => d.column));
  return [...new Set(sources)].filter((key) => {
    const column = byKey.get(key);
    return column && !written.has(key) && sourceFits(column, field);
  });
}

/**
 * Define the field from a column: a picklist makes it a category with that column's options, a number makes it a
 * quantity, on that column's kind of record. Any picklist or number column works, in any CRM, writable or not. Its
 * destinations and sources, in priority order, come with it. The value map keeps its entries: they map source values.
 */
export const define = mutation({
  args: { id: v.id("fieldConsolidations"), from: v.string(), destinations: v.array(destinationValidator), sources: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const columns = (doc.columns ?? []) as Column[];
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const from = byKey.get(args.from);
    if (!from) throw new ConvexError("That column isn't part of this field.");
    if (from.kind !== "picklist" && from.kind !== "number") throw new ConvexError("Define the field from a picklist (its options) or a number column (an amount).");
    const field: FieldDefinition = { measure: measureOf(from), level: COLUMN_OBJECTS[from.object].level, options: from.kind === "picklist" ? from.options : [] };
    const destinations = checkDestinations(args.destinations, byKey, field);
    // A field that becomes another kind, or moves to other records, picks its attribute again at the next preview.
    const same = doc.kind === field.measure && doc.level === field.level;
    await ctx.db.patch(doc._id, {
      kind: field.measure, level: field.level, options: field.options, optionsFrom: from.key, destinations,
      ...(same ? {} : { attribute: undefined }),
      sources: checkSources(args.sources, byKey, field, destinations),
      settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now(),
    });
    return null;
  },
});

/** Replace the columns the field writes, each with its mode. Sources that became destinations stop being sources. */
export const setDestinations = mutation({
  args: { id: v.id("fieldConsolidations"), destinations: v.array(destinationValidator) },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const columns = (doc.columns ?? []) as Column[];
    const field = fieldDefinition(doc, columns);
    if (!field) throw new ConvexError("Define the field first.");
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const destinations = checkDestinations(args.destinations, byKey, field);
    await ctx.db.patch(doc._id, {
      ...definitionPatch(doc, columns), destinations, sources: checkSources(doc.sources ?? [], byKey, field, destinations),
      settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now(),
    });
    return null;
  },
});

/** Replace the source columns, in priority order: any column on the field's kind of record, in any CRM. */
export const setSources = mutation({
  args: { id: v.id("fieldConsolidations"), sources: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const columns = (doc.columns ?? []) as Column[];
    const field = fieldDefinition(doc, columns);
    if (!field) throw new ConvexError("Define the field first.");
    const byKey = new Map(columns.map((c) => [c.key, c]));
    await ctx.db.patch(doc._id, {
      ...definitionPatch(doc, columns), sources: checkSources(args.sources, byKey, field, destinationsOf(doc)),
      settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now(),
    });
    return null;
  },
});

/** Replace the value map (the page sends it whole after an edit or a suggestion pass). */
export const setMap = mutation({
  args: { id: v.id("fieldConsolidations"), entries: v.array(entryValidator) },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    if (args.entries.length > MAX_MAP_ENTRIES) throw new ConvexError(`A map holds at most ${MAX_MAP_ENTRIES} source values.`);
    const entries = args.entries.map((e) => ({ ...e, confidence: Math.max(0, Math.min(1, e.confidence)) }));
    await ctx.db.patch(doc._id, { valueMap: entries, settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now() });
    return null;
  },
});

/** Replace the source columns' scales into a quantity standard's units (the page sends them whole). */
export const setScales = mutation({
  args: { id: v.id("fieldConsolidations"), scales: v.array(scaleValidator) },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    if (args.scales.some((e) => !(SCALE_FACTORS as readonly number[]).includes(e.factor))) throw new ConvexError("Scales are powers of 1,000.");
    // A ×1 the user chose is kept: it rejects a suggestion, so "Suggest scales" leaves that source alone.
    const scales = [...new Map(args.scales.filter((e) => e.factor !== 1 || e.origin === "user").map((e) => [e.column, e])).values()];
    await ctx.db.patch(doc._id, { scales, settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now() });
    return null;
  },
});

export const setPolicy = mutation({
  args: { id: v.id("fieldConsolidations"), policy: policyValidator },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const policy = {
      ...args.policy,
      minConfidence: Math.max(0, Math.min(1, args.policy.minConfidence)),
      protectedValues: args.policy.protectedValues.slice(0, 200),
      ...(args.policy.tolerance !== undefined ? { tolerance: Math.max(0, Math.min(1, args.policy.tolerance)) } : {}),
    };
    await ctx.db.patch(doc._id, { policy, settingsVersion: (doc.settingsVersion ?? 0) + 1, updatedAt: Date.now() });
    return null;
  },
});

/** Delete a Canon field with its profiles and runs. Nothing in the CRM changes; values a run wrote stay written. */
export const remove = mutation({
  args: { id: v.id("fieldConsolidations") },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const runs = await ctx.db
      .query("fieldConsolidationRuns")
      .withIndex("by_consolidationId_and_createdAt", (q) => q.eq("consolidationId", doc._id))
      .take(200);
    if (runs.some(writing)) throw new ConvexError("A run is writing to your CRM. Wait for it to finish first.");
    for (const run of runs) await dropRun(ctx, run);
    const profiles = await ctx.db
      .query("fieldConsolidationProfiles")
      .withIndex("by_consolidationId_and_object", (q) => q.eq("consolidationId", doc._id))
      .take(Object.keys(COLUMN_OBJECTS).length);
    for (const p of profiles) await ctx.db.delete(p._id);
    await ctx.db.delete(doc._id);
    return null;
  },
});

// ── Internal: the actions' side ──────────────────────────────────────────────

/** The consolidation an action works on, checked against the caller (public actions) or not (scheduled ones). */
export const forAction = internalQuery({
  args: { id: v.id("fieldConsolidations"), caller: v.boolean() },
  handler: async (ctx, args) => {
    if (args.caller) {
      const { user, doc } = await owned(ctx, args.id);
      return { doc, userId: user._id };
    }
    const doc = await ctx.db.get(args.id);
    return doc ? { doc, userId: null } : null;
  },
});

/** Free-fill properties the org's Canon fields own (lib/consolidate.ts canonOwnedFields): free fill leaves them alone. */
export async function canonFieldOwners(ctx: QueryCtx, orgId: Id<"organizations">) {
  const docs = await ctx.db.query("fieldConsolidations").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").take(100);
  return canonOwnedFields(docs);
}

export const ownedFields = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => (await canonFieldOwners(ctx, args.orgId)).map((o) => o.property),
});

export const saveColumns = internalMutation({
  args: {
    id: v.id("fieldConsolidations"),
    columns: v.any(),
    systems: v.array(v.object({ system: v.string(), status: v.string(), detail: v.optional(v.string()) })),
    objects: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return null;
    const old = await ctx.db
      .query("fieldConsolidationProfiles")
      .withIndex("by_consolidationId_and_object", (q) => q.eq("consolidationId", args.id))
      .take(Object.keys(COLUMN_OBJECTS).length);
    for (const p of old) await ctx.db.delete(p._id);
    const now = Date.now();
    for (const object of args.objects) {
      await ctx.db.insert("fieldConsolidationProfiles", { orgId: doc.orgId, consolidationId: args.id, object, stage: "reading", read: 0, updatedAt: now });
    }
    await ctx.db.patch(args.id, {
      columns: args.columns,
      discoveryVersion: DISCOVERY_VERSION,
      systems: args.systems,
      stage: args.objects.length ? "profiling" : "ready",
      updatedAt: now,
    });
    return null;
  },
});

async function profileRow(ctx: MutationCtx, id: Id<"fieldConsolidations">, object: string) {
  return await ctx.db
    .query("fieldConsolidationProfiles")
    .withIndex("by_consolidationId_and_object", (q) => q.eq("consolidationId", id).eq("object", object))
    .unique();
}

/** Settle the consolidation once no object is still being read. */
async function settle(ctx: MutationCtx, id: Id<"fieldConsolidations">) {
  const rows = await ctx.db
    .query("fieldConsolidationProfiles")
    .withIndex("by_consolidationId_and_object", (q) => q.eq("consolidationId", id))
    .take(Object.keys(COLUMN_OBJECTS).length);
  if (rows.every((r) => r.stage !== "reading")) await ctx.db.patch(id, { stage: "ready", updatedAt: Date.now() });
}

export const profileProgress = internalMutation({
  args: { id: v.id("fieldConsolidations"), object: v.string(), read: v.number() },
  handler: async (ctx, args) => {
    const row = await profileRow(ctx, args.id, args.object);
    if (row) await ctx.db.patch(row._id, { read: args.read, updatedAt: Date.now() });
    return null;
  },
});

export const saveProfile = internalMutation({
  args: { id: v.id("fieldConsolidations"), object: v.string(), profile: v.optional(v.any()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await profileRow(ctx, args.id, args.object);
    if (!row) return null;
    await ctx.db.patch(row._id, {
      stage: args.error ? "error" : "done",
      ...(args.profile ? { profile: args.profile, read: args.profile.read } : {}),
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      updatedAt: Date.now(),
    });
    await settle(ctx, args.id);
    return null;
  },
});

export const fail = internalMutation({
  args: { id: v.id("fieldConsolidations"), error: v.string() },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { stage: "error", error: args.error.slice(0, 500), updatedAt: Date.now() });
    return null;
  },
});

const TASK_TITLE = { suggest: "Suggesting value mappings", preview: "Previewing changes", plans: "Creating plans", apply: "Applying changes", undo: "Undoing changes" } as const;
const task = v.union(v.literal("suggest"), v.literal("preview"), v.literal("plans"), v.literal("apply"), v.literal("undo"));

/** A suggest, preview, apply or undo: a background job the page and the tray both show, owned by the member who started it. */
export const startJob = internalMutation({
  args: {
    id: v.id("fieldConsolidations"),
    userId: v.id("users"),
    task,
    detail: v.string(),
    phases: v.array(v.object({ key: v.string(), label: v.string(), status: v.literal("processing"), total: v.optional(v.number()), done: v.optional(v.number()) })),
  },
  handler: async (ctx, args): Promise<Id<"backgroundJobs">> => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new ConvexError("Consolidation not found");
    const now = Date.now();
    const jobId = await ctx.db.insert("backgroundJobs", {
      orgId: doc.orgId, userId: args.userId, kind: "field_consolidation", title: `${TASK_TITLE[args.task]}: ${doc.concept}`,
      href: `/dashboard/canon-fields/${args.id}`, detail: args.detail, phases: args.phases, status: "processing", startedAt: now, updatedAt: now,
    });
    await ctx.db.patch(args.id, { job: { id: jobId, task: args.task } });
    return jobId;
  },
});

// ── Runs: a saved preview, applied and undone as one unit ────────────────────

/**
 * Apply the saved preview: every proposed write, as one unit. Nothing is read again first; each write is still
 * checked against the value the preview saw (compare-and-set), so a record someone changed since is left alone and
 * counted as a conflict. A failed apply resumes from the writes still pending.
 */
export const applyRun = mutation({
  args: { id: v.id("fieldConsolidations"), runId: v.id("fieldConsolidationRuns") },
  handler: async (ctx, args) => {
    const { user, doc } = await owned(ctx, args.id);
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const run = await ctx.db.get(args.runId);
    if (!run || run.consolidationId !== doc._id) throw new ConvexError("Preview not found");
    const resuming = run.status === "failed" && run.failedDuring === "apply";
    // An applied run whose writes failed (a rate limit, a permission since fixed) retries just those.
    const retry = run.status === "applied" && (run.applied?.failed ?? 0) > 0;
    if (run.status !== "ready" && !resuming && !retry) throw new ConvexError(`This preview is ${run.status}; it can't be applied.`);
    if (run.status === "ready" && run.settingsVersion !== (doc.settingsVersion ?? 0)) {
      throw new ConvexError("The map or policy changed since this preview. Preview again, then apply.");
    }
    if (!run.writes) throw new ConvexError("This preview has nothing to write.");
    return startWriting(ctx, user, doc, run, "apply", retry);
  },
});

/** Put back every value a run wrote, as one unit. A record changed since the run wrote it is left alone. */
export const undoRun = mutation({
  args: { id: v.id("fieldConsolidations"), runId: v.id("fieldConsolidationRuns") },
  handler: async (ctx, args) => {
    const { user, doc } = await owned(ctx, args.id);
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const run = await ctx.db.get(args.runId);
    if (!run || run.consolidationId !== doc._id) throw new ConvexError("Run not found");
    const resuming = run.status === "failed" && run.failedDuring === "undo";
    // An undone run whose undo writes failed retries just those.
    const retry = run.status === "undone" && (run.undone?.failed ?? 0) > 0;
    // A stopped apply resumes first: that settles writes it sent but didn't record, so undo then covers all of them.
    if (run.status === "failed" && run.failedDuring === "apply") throw new ConvexError("This apply stopped part way. Resume it first, then undo the run.");
    if (run.status !== "applied" && !resuming && !retry) throw new ConvexError(`This run is ${run.status}; there is nothing to undo.`);
    return startWriting(ctx, user, doc, run, "undo", retry);
  },
});

async function startWriting(ctx: MutationCtx, user: Doc<"users">, doc: Doc<"fieldConsolidations">, run: Doc<"fieldConsolidationRuns">, mode: "apply" | "undo", retry = false) {
  const now = Date.now();
  const runs = await ctx.db
    .query("fieldConsolidationRuns")
    .withIndex("by_consolidationId_and_createdAt", (q) => q.eq("consolidationId", doc._id))
    .order("desc")
    .take(HISTORY);
  if (runs.some((r) => r._id !== run._id && writing(r))) throw new ConvexError("Another run of this consolidation is writing. Wait for it to finish.");
  await ctx.db.patch(run._id, {
    status: mode === "apply" ? "applying" : "undoing", error: undefined, failedDuring: undefined, updatedAt: now,
    ...(mode === "apply" ? { appliedBy: user._id, appliedAt: run.appliedAt ?? now } : { undoneBy: user._id }),
  });
  await ctx.db.insert("operationAuditLog", {
    orgId: doc.orgId, userId: user._id, verb: "do", operation: mode === "apply" ? "consolidate.field" : "consolidate.undo", status: "approved",
    details: { consolidationId: doc._id, runId: run._id, concept: doc.concept, writes: run.writes, ...(run.status === "failed" ? { resumed: true } : {}), ...(retry ? { retryFailed: run.applied?.failed } : {}) },
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.fieldConsolidationActions.writeRun, { runId: run._id, mode, userId: user._id, first: true, ...(retry ? { retry } : {}) });
  return null;
}

export const runForAction = internalQuery({
  args: { runId: v.id("fieldConsolidationRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const doc = run ? await ctx.db.get(run.consolidationId) : null;
    return run && doc ? { run, doc } : null;
  },
});

/**
 * A new preview run. Refused while another run writes; the previous preview, if it never wrote anything, is dropped
 * (a run that wrote stays, so it can be undone).
 */
export const startRun = internalMutation({
  // The settings version the preview read: the run is stamped with it, so an edit since makes it stale.
  args: { id: v.id("fieldConsolidations"), userId: v.id("users"), settingsVersion: v.number() },
  handler: async (ctx, args): Promise<Id<"fieldConsolidationRuns">> => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new ConvexError("Consolidation not found");
    if ((doc.settingsVersion ?? 0) !== args.settingsVersion) throw new ConvexError("The map or policy changed as the preview started. Preview again.");
    const runs = await ctx.db
      .query("fieldConsolidationRuns")
      .withIndex("by_consolidationId_and_createdAt", (q) => q.eq("consolidationId", doc._id))
      .order("desc")
      .take(HISTORY);
    if (runs.some(writing)) throw new ConvexError("A run is writing to your CRM. Preview again when it finishes.");
    for (const run of runs) if (previewOnly(run)) await dropRun(ctx, run);
    const now = Date.now();
    const runId = await ctx.db.insert("fieldConsolidationRuns", {
      orgId: doc.orgId, consolidationId: doc._id, createdBy: args.userId, settingsVersion: args.settingsVersion,
      status: "previewing", writes: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(doc._id, { run: runId });
    return runId;
  },
});

const writeValidator = v.object({
  provider: v.union(v.literal("hubspot"), v.literal("salesforce")),
  objectType: v.union(v.literal("account"), v.literal("contact")),
  recordId: v.string(),
  field: v.string(),
  before: v.union(v.string(), v.null()),
  after: v.string(),
  kind: v.union(v.literal("fill"), v.literal("change")),
  reason: v.string(),
});

export const insertWrites = internalMutation({
  args: { runId: v.id("fieldConsolidationRuns"), writes: v.array(writeValidator) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "previewing") throw new ConvexError("This preview was replaced or removed.");
    for (const w of args.writes) await ctx.db.insert("fieldConsolidationWrites", { ...w, orgId: run.orgId, runId: run._id, status: "pending" });
    await ctx.db.patch(run._id, { writes: run.writes + args.writes.length, updatedAt: Date.now() });
    return null;
  },
});

export const finishPreview = internalMutation({
  args: { runId: v.id("fieldConsolidationRuns"), sections: v.any(), csv: v.id("_storage"), csvRows: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      await ctx.storage.delete(args.csv);
      return null;
    }
    await ctx.db.patch(run._id, { status: "ready", sections: args.sections, csv: args.csv, csvRows: args.csvRows, updatedAt: Date.now() });
    return null;
  },
});

export const failRun = internalMutation({
  args: { runId: v.id("fieldConsolidationRuns"), during: v.union(v.literal("preview"), v.literal("apply"), v.literal("undo")), error: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "failed", failedDuring: args.during, error: args.error.slice(0, 500), updatedAt: now });
    if (args.during !== "preview") {
      await ctx.db.insert("operationAuditLog", {
        orgId: run.orgId, verb: "do", operation: args.during === "apply" ? "consolidate.field" : "consolidate.undo", status: "failed",
        details: { consolidationId: run.consolidationId, runId: run._id, error: args.error.slice(0, 500) },
        createdAt: now,
      });
    }
    return null;
  },
});

/**
 * The next writes for an apply or an undo: first any an earlier action sent without recording the outcome (writing,
 * unwriting), then those waiting (pending; applied for an undo).
 */
export const nextWrites = internalQuery({
  args: { runId: v.id("fieldConsolidationRuns"), mode: v.union(v.literal("apply"), v.literal("undo")), limit: v.number() },
  handler: async (ctx, args) => {
    const [sent, waiting] = args.mode === "apply" ? (["writing", "pending"] as const) : (["unwriting", "applied"] as const);
    const unsettled = await ctx.db.query("fieldConsolidationWrites").withIndex("by_runId_and_status", (q) => q.eq("runId", args.runId).eq("status", sent)).take(args.limit);
    if (unsettled.length) return unsettled;
    return ctx.db.query("fieldConsolidationWrites").withIndex("by_runId_and_status", (q) => q.eq("runId", args.runId).eq("status", waiting)).take(args.limit);
  },
});

/** Mark writes as sent before the CRM call, so a later action knows which records this run may already have changed. */
export const markSent = internalMutation({
  args: { ids: v.array(v.id("fieldConsolidationWrites")), mode: v.union(v.literal("apply"), v.literal("undo")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) await ctx.db.patch(id, { status: args.mode === "apply" ? "writing" : "unwriting" });
    return null;
  },
});

const outcome = v.union(v.literal("applied"), v.literal("conflict"), v.literal("failed"));

/**
 * Put up to 500 failed writes back where they wait, off the failed count: an apply's to pending, an undo's to applied.
 * Returns how many it moved.
 */
export const requeueFailed = internalMutation({
  args: { runId: v.id("fieldConsolidationRuns"), mode: v.union(v.literal("apply"), v.literal("undo")) },
  handler: async (ctx, args): Promise<number> => {
    const run = await ctx.db.get(args.runId);
    if (!run) return 0;
    const [from, to] = args.mode === "apply" ? (["failed", "pending"] as const) : (["undoFailed", "applied"] as const);
    const page = await ctx.db.query("fieldConsolidationWrites").withIndex("by_runId_and_status", (q) => q.eq("runId", args.runId).eq("status", from)).take(500);
    for (const w of page) await ctx.db.patch(w._id, { status: to, detail: undefined });
    const counts = args.mode === "apply" ? run.applied : run.undone;
    if (page.length && counts) {
      await ctx.db.patch(run._id, { [args.mode === "apply" ? "applied" : "undone"]: { ...counts, failed: Math.max(0, counts.failed - page.length) } });
    }
    return page.length;
  },
});

/** Record a chunk's outcomes on the writes and add them to the run's counts. */
export const recordWrites = internalMutation({
  args: {
    runId: v.id("fieldConsolidationRuns"),
    mode: v.union(v.literal("apply"), v.literal("undo")),
    results: v.array(v.object({ id: v.id("fieldConsolidationWrites"), outcome, detail: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const counts = { ...((args.mode === "apply" ? run.applied : run.undone) ?? { applied: 0, conflict: 0, failed: 0 }) };
    const STATUS = args.mode === "apply"
      ? ({ applied: "applied", conflict: "conflict", failed: "failed" } as const)
      : ({ applied: "undone", conflict: "undoConflict", failed: "undoFailed" } as const);
    for (const r of args.results) {
      await ctx.db.patch(r.id, { status: STATUS[r.outcome], ...(r.detail ? { detail: r.detail.slice(0, 300) } : {}) });
      counts[r.outcome]++;
    }
    await ctx.db.patch(run._id, { [args.mode === "apply" ? "applied" : "undone"]: counts, updatedAt: Date.now() });
    return null;
  },
});

export const finishWriting = internalMutation({
  args: { runId: v.id("fieldConsolidationRuns"), mode: v.union(v.literal("apply"), v.literal("undo")), userId: v.id("users") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const now = Date.now();
    await ctx.db.patch(run._id, args.mode === "apply" ? { status: "applied", updatedAt: now } : { status: "undone", undoneAt: now, updatedAt: now });
    await ctx.db.insert("operationAuditLog", {
      orgId: run.orgId, userId: args.userId, verb: "do", operation: args.mode === "apply" ? "consolidate.field" : "consolidate.undo", status: "applied",
      details: { consolidationId: run.consolidationId, runId: run._id, writes: run.writes, outcome: args.mode === "apply" ? run.applied : run.undone },
      createdAt: now,
    });
    return null;
  },
});

/**
 * The Canon company or person each of a preview's Canon records is, found by the CRM ids of its records (following
 * merges), with its ledger shard, and whether it already holds this value from a Canon field, so saving can skip it.
 * Null for a record Canon doesn't hold yet.
 */
export const resolveForStore = internalQuery({
  args: {
    orgId: v.id("organizations"),
    attribute: v.string(),
    rows: v.array(v.object({ ids: v.array(v.object({ provider: v.string(), externalId: v.string() })), value: v.union(v.string(), v.number()) })),
  },
  handler: async (ctx, args) => {
    const out: Array<{ entityId: Id<"canonEntities">; shard: number; held: boolean } | null> = [];
    for (const row of args.rows) {
      let entityId: Id<"canonEntities"> | null = null;
      for (const id of row.ids) {
        const hit = await ctx.db
          .query("canonExternalIds")
          .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", args.orgId).eq("provider", id.provider).eq("externalId", id.externalId))
          .first();
        if (hit) {
          entityId = await survivorOf(ctx, hit.entityId);
          break;
        }
      }
      if (!entityId) {
        out.push(null);
        continue;
      }
      const state = await ctx.db
        .query("canonFieldState")
        .withIndex("by_entityId_attribute", (q) => q.eq("entityId", entityId).eq("attribute", args.attribute))
        .first();
      // canonFieldState trails the ledger while mirror jobs are queued for the record, so it is trusted only once they ran.
      const pending = state?.sourceKind === "canon_field" && state.value === row.value
        ? await ctx.db.query("partyMirrorQueue").withIndex("by_streamId", (q) => q.eq("streamId", entityId)).first()
        : null;
      out.push({ entityId, shard: shardOf(entityId), held: state?.sourceKind === "canon_field" && state.value === row.value && !pending });
    }
    return out;
  },
});

/**
 * Save a page of a preview's Canon values onto Canon's companies or people, as facts from the field (`canon_field`).
 * A page holds one ledger shard's records, so pages of different shards save side by side without colliding on its
 * head. A value the field already said is left as it is, so a person's newer edit stands until the field's decision
 * changes. Returns how many were written and how many were already there.
 */
export const storeValues = internalMutation({
  args: {
    id: v.id("fieldConsolidations"),
    runId: v.id("fieldConsolidationRuns"),
    attribute: v.string(),
    object: v.union(v.literal("account"), v.literal("contact")),
    at: v.number(),
    rows: v.array(v.object({ entityId: v.id("canonEntities"), value: v.union(v.string(), v.number()), evidence: v.string() })),
  },
  handler: async (ctx, args): Promise<{ written: number; unchanged: number }> => {
    const doc = await ctx.db.get(args.id);
    const run = await ctx.db.get(args.runId);
    // A replaced preview, or settings changed since it read the records: its decisions are stale, so none is saved.
    if (!doc || !run || run.status !== "previewing" || (doc.settingsVersion ?? 0) !== run.settingsVersion) return { written: 0, unchanged: 0 };
    const counts = { written: 0, unchanged: 0 };
    for (const row of args.rows) {
      const out = await saveParty(ctx, {
        orgId: doc.orgId, object: args.object, identity: { entityId: row.entityId }, source: { kind: "canon_field", fieldId: doc._id, at: args.at },
        values: { [args.attribute]: row.value }, evidence: row.evidence, deferMirror: true,
      });
      if (out.result.status === "unchanged") counts.unchanged++;
      else counts.written++;
    }
    return counts;
  },
});

/** The preview's save counts and the attribute it saved into, recorded once when saving finishes. */
export const recordStored = internalMutation({
  args: {
    id: v.id("fieldConsolidations"),
    runId: v.id("fieldConsolidationRuns"),
    attribute: v.string(),
    stored: v.object({ written: v.number(), unchanged: v.number(), missing: v.number() }),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    const run = await ctx.db.get(args.runId);
    if (!doc || !run || run.status !== "previewing" || (doc.settingsVersion ?? 0) !== run.settingsVersion) return null;
    if (doc.attribute !== args.attribute) await ctx.db.patch(doc._id, { attribute: args.attribute });
    await ctx.db.patch(run._id, { stored: args.stored, updatedAt: Date.now() });
    return null;
  },
});

/** A dropped run's writes, a page at a time. */
export const deleteWrites = internalMutation({
  args: { runId: v.id("fieldConsolidationRuns") },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("fieldConsolidationWrites").withIndex("by_runId_and_status", (q) => q.eq("runId", args.runId)).take(500);
    for (const w of page) await ctx.db.delete(w._id);
    if (page.length === 500) await ctx.scheduler.runAfter(0, internal.fieldConsolidations.deleteWrites, { runId: args.runId });
    return null;
  },
});

/** Remember the plans an approve (or undo) created, newest first. */
export const recordPlans = internalMutation({
  args: {
    id: v.id("fieldConsolidations"),
    plans: v.array(v.object({ patchPlanId: v.id("patchPlans"), provider: v.string(), operations: v.number(), kind: v.string() })),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return null;
    const now = Date.now();
    const plans = [...args.plans.map((p) => ({ ...p, createdAt: now })), ...(doc.plans ?? [])].slice(0, 50);
    await ctx.db.patch(args.id, { plans, updatedAt: now });
    return null;
  },
});

/** The applied operations of a plan this consolidation created, for building its undo. */
export const appliedOperations = internalQuery({
  args: { id: v.id("fieldConsolidations"), patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const { doc } = await owned(ctx, args.id);
    const entry = (doc.plans ?? []).find((p) => p.patchPlanId === args.patchPlanId);
    if (!entry) throw new ConvexError("That plan wasn't created by this consolidation.");
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== doc.orgId) throw new ConvexError("Plan not found");
    const ops = await ctx.db
      .query("patchOperations")
      .withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId))
      .take(5000);
    return {
      provider: entry.provider,
      planStatus: plan.status,
      operations: ops
        .filter((op) => op.status === "applied" && op.objectId)
        .map((op) => ({ objectType: op.objectType, objectId: op.objectId!, field: op.fieldOrAction, beforeValue: op.beforeValue ?? null, afterValue: op.afterValue ?? null })),
    };
  },
});
