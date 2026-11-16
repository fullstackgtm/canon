/**
 * Recipes, Data model (CP7a): the fields of each object, and the admin's
 * create, rename, hide, archive and picklist edits of custom fields
 * (lib/objects/fieldBuilder.ts). A change bumps the object's registryVersion
 * and nudges the record service, whose projector picks up the new definition
 * on its next catch-up: a new field gets a column, a label or flag change is
 * stored with the definition.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser, logDataModelChange } from "./lib";
import { scheduleNudge } from "./ledgerFeed";
import {
  addField, archiveField, builderOwns, MODELED_OBJECTS, restoreField, updateField, type ComputeSpec, type FieldPatch, type RelatedDefs,
} from "./lib/objects/fieldBuilder";
import { isRegisterObject } from "./lib/objects/listSpec";
import { RegistryError, resolveOrgObject, STANDARD_OBJECTS, type OrgObjectExtension } from "./lib/objects/registry";
import { isCustomObjectName } from "../modules/kernel/reportLanguage";
import { customObjectRows, loadOrgObject, objectNames, objectRow } from "./lib/objects/orgDefs";
import { relabelObject } from "./lib/objects/customObjects";
import { dataModelRelabelArgs, dataModelSetArchivedArgs, dataModelUpdateFieldDefArgs, dataModelCreateFieldArgs, fromStored, toStored } from "./lib/objects/validators";

/** A standard object the builder models, or one of the org's own (custom_<slug>); the set differs per org, so it is checked on use. */
const modeledObject = v.string();
/** An org holds at most this many AI fields (researchAgents.MAX_AGENTS). */
const AI_FIELDS_MAX = 50;

async function readExt(ctx: QueryCtx, orgId: Id<"organizations">, object: string) {
  const row = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId).eq("apiName", object)).unique();
  return { row, ext: row ? fromStored<OrgObjectExtension>(row) : undefined };
}

/** The slugs of the org's AI fields: each answers into its own `custom.<slug>` field, which the AI fields page manages. They are companies' and people's; a custom object's `custom.name` is never one. */
async function aiSlugs(ctx: QueryCtx, orgId: Id<"organizations">, object?: string): Promise<Set<string>> {
  if (object !== undefined && isCustomObjectName(object)) return new Set();
  const agents = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).take(AI_FIELDS_MAX);
  return new Set(agents.map((a) => a.slug));
}

async function requireAdmin(ctx: MutationCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!can(user, "dataModel.edit")) throw new ConvexError(refusal("dataModel.edit"));
  return user;
}

/** The object must be one the builder models for this org: a standard one, or a custom one that is not archived. */
function requireModeled(object: string, ext: OrgObjectExtension | undefined) {
  if ((MODELED_OBJECTS as readonly string[]).includes(object)) return;
  if (!isCustomObjectName(object) || !ext?.object) throw new ConvexError(`Unknown object ${object}`);
  if (ext.object.archivedAt !== undefined) throw new ConvexError(`${ext.object.pluralLabel} is archived; restore it before changing its fields`);
}

const CHANGE_VERBS = { object_relabeled: "Renamed", field_created: "Added field", field_updated: "Updated field", field_archived: "Archived field", field_restored: "Restored field" };

/** Run a builder change against the org's extension, store it, and tell the projector. */
async function change(
  ctx: MutationCtx, object: string, event: { kind: keyof typeof CHANGE_VERBS; fieldId?: string }, run: (ext: OrgObjectExtension | undefined, ai: Set<string>) => OrgObjectExtension,
): Promise<OrgObjectExtension> {
  const user = await requireAdmin(ctx);
  const { row, ext } = await readExt(ctx, user.orgId, object);
  requireModeled(object, ext);
  let next: OrgObjectExtension;
  try {
    next = run(ext, await aiSlugs(ctx, user.orgId, object));
  } catch (e) {
    if (e instanceof RegistryError) throw new ConvexError(e.message);
    throw e;
  }
  const doc = {
    registryVersion: next.registryVersion, customFields: toStored(next.customFields), updatedAt: Date.now(),
    ...(next.picklistOptions ? { picklistOptions: toStored(next.picklistOptions) } : {}),
    labels: next.labels,
  };
  if (row) await ctx.db.patch(row._id, doc);
  else await ctx.db.insert("objectDefs", { orgId: user.orgId, apiName: object, ...doc });
  const resolved = resolveOrgObject(object, next)!;
  const field = event.fieldId ? resolved.fields.find((f) => f.fieldId === event.fieldId)
    : event.kind === "field_created" ? next.customFields.find((f) => !ext?.customFields.some((old) => old.fieldId === f.fieldId)) : undefined;
  const verb = CHANGE_VERBS[event.kind];
  await logDataModelChange(ctx, user, { ...event, ...(field ? { fieldId: field.fieldId } : {}), object,
    summary: `${verb}${field ? ` ${field.label} on` : ""} ${resolved.pluralLabel}`,
    registryVersion: next.registryVersion });
  await scheduleNudge(ctx, user.orgId);
  return next;
}

/** Refuse a change to an AI field's answer column here: the AI fields page owns it. */
function ownedBy(ext: OrgObjectExtension | undefined, fieldId: string, ai: Set<string>) {
  const field = ext?.customFields.find((f) => f.fieldId === fieldId);
  if (field && !builderOwns(field, ai)) throw new RegistryError(`${field.label} is an AI field; change it on the AI fields page`);
}

/**
 * The definition of the object a rollup reads, loaded before the change runs. Accounts and contacts are not
 * sources: the register holds them, and rollups read the projection's tables.
 */
async function rollupSource(ctx: QueryCtx, orgId: Id<"organizations">, spec: ComputeSpec | undefined): Promise<RelatedDefs> {
  const object = spec?.rollup?.object;
  if (!object || isRegisterObject(object)) return () => null;
  const def = await loadOrgObject(ctx, orgId, object);
  return (name) => (name === object ? def : null);
}

/**
 * The records a rollup on `object` can read: each object with a live lookup pointing at it, with those lookups and the
 * fields a rollup can total.
 */
async function rollupSources(ctx: QueryCtx, orgId: Id<"organizations">, object: string) {
  const own = (await customObjectRows(ctx, orgId)).filter((r) => r.object!.archivedAt === undefined).map((r) => r.apiName);
  const out = [];
  for (const name of [...MODELED_OBJECTS.filter((o) => !isRegisterObject(o)), ...own]) {
    const def = await loadOrgObject(ctx, orgId, name);
    if (!def) continue;
    const live = def.fields.filter((f) => f.archivedAt === undefined);
    const via = live.filter((f) => f.type === "lookup" && f.lookupTo === object).map((f) => ({ fieldId: f.fieldId as string, label: f.label }));
    if (!via.length) continue;
    const fields = live.filter((f) => ["number", "currency", "date", "datetime"].includes(f.type)).map((f) => ({ fieldId: f.fieldId as string, label: f.label, type: f.type }));
    const filterable = live.filter((f) => (f.type !== "formula" && !f.system) || f.apiName === "createdAt").map((f) => ({ apiName: f.apiName, label: f.label }));
    out.push({ object: name, label: def.label, pluralLabel: def.pluralLabel, via, fields, filterable });
  }
  return out;
}

/** Every object the builder models, with its custom field count. */
export const objects = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const out = [];
    for (const object of MODELED_OBJECTS) {
      const { ext } = await readExt(ctx, user.orgId, object);
      const spec = ext?.labels ?? STANDARD_OBJECTS[object];
      out.push({ apiName: object, label: spec.label, pluralLabel: spec.pluralLabel, relabeled: Boolean(ext?.labels), customFields: (ext?.customFields ?? []).filter((f) => f.archivedAt === undefined).length, custom: false, icon: null, archived: false });
    }
    // The org's own objects (CP7d), live ones first; an archived one stays listed so it can be restored.
    const own = (await customObjectRows(ctx, user.orgId)).map((row) => {
      const meta = row.object!;
      return { apiName: row.apiName, label: meta.label, pluralLabel: meta.pluralLabel, customFields: row.customFields.filter((f) => f.archivedAt === undefined).length, custom: true, icon: meta.icon, archived: meta.archivedAt !== undefined };
    });
    return [...out, ...own.filter((o) => !o.archived), ...own.filter((o) => o.archived)];
  },
});

/** The standard objects this workspace renamed, as it names them. */
export const relabels = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", args.orgId)).take(100);
    return rows.flatMap((r) => (r.labels ? [{ object: r.apiName, ...r.labels }] : []));
  },
});

/** Rename a standard object in this workspace (People called Contacts); empty names bring back Canon's. Admins only. */
export const relabel = mutation({
  args: dataModelRelabelArgs,
  handler: async (ctx, args) => {
    if (!(MODELED_OBJECTS as readonly string[]).includes(args.object)) throw new ConvexError("Rename your own objects from their row");
    const names = await objectNames(ctx, (await requireUser(ctx)).orgId);
    const reset = !args.label.trim() && !args.pluralLabel.trim();
    await change(ctx, args.object, { kind: "object_relabeled" }, (ext) => relabelObject(args.object, ext, reset ? null : args, names));
  },
});

/** One object's fields, standard then custom, archived ones last, and whether the caller may change them. */
/** A unique check's link: the data model, with the field it is about (`fields` finds a field's latest check by it). */
const uniqueJobHref = (object: string, fieldId: string) => `/dashboard/customization/data-model#${object}.${fieldId}`;
/** Recent jobs read for the latest unique check of each field. */
const UNIQUE_JOBS_READ = 50;

export const fields = query({
  args: { object: modeledObject },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const { ext } = await readExt(ctx, user.orgId, args.object);
    const ai = await aiSlugs(ctx, user.orgId, args.object);
    const def = (MODELED_OBJECTS as readonly string[]).includes(args.object) || ext?.object ? resolveOrgObject(args.object, ext) : null;
    if (!def) return null;
    const customIds = new Set((ext?.customFields ?? []).map((f) => f.fieldId as string));
    const jobs = can(user, "dataModel.edit")
      ? (await ctx.db.query("backgroundJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(UNIQUE_JOBS_READ)).filter((j) => j.kind === "unique_field")
      : [];
    const rows = def.fields.filter((f) => !f.system).map((f) => {
      const custom = customIds.has(f.fieldId);
      const check = jobs.find((j) => j.href === uniqueJobHref(args.object, f.fieldId));
      return {
        ...toStored(f), kind: !custom ? "standard" as const : builderOwns(f, ai) ? "custom" as const : "ai" as const, isName: f.fieldId === def.titleFieldId,
        /** The latest turn-on or turn-off of uniqueness: its progress, or why it was refused. */
        ...(check ? { uniqueCheck: { status: check.status, detail: check.detail ?? null, error: check.error ?? null } } : {}),
      };
    });
    return {
      object: args.object, label: def.label, pluralLabel: def.pluralLabel, custom: def.kind === "custom", icon: def.icon ?? null, archived: def.archivedAt !== undefined,
      canEdit: can(user, "dataModel.edit") && def.archivedAt === undefined,
      /** Renaming and archiving a custom object stay open to admins while it is archived, so it can be restored. */
      canEditObject: can(user, "dataModel.edit"),
      fields: [...rows.filter((f) => f.archivedAt === undefined), ...rows.filter((f) => f.archivedAt !== undefined)],
      /** What a rollup on this object can read (CP7c). */
      rollupSources: can(user, "dataModel.edit") ? await rollupSources(ctx, user.orgId, args.object) : [],
    };
  },
});

export const createField = mutation({
  args: dataModelCreateFieldArgs,
  returns: v.object({ fieldId: v.string(), apiName: v.string() }),
  handler: async (ctx, { object, ...spec }) => {
    const user = await requireAdmin(ctx);
    if (spec.lookupTo && isCustomObjectName(spec.lookupTo)) {
      if (!(await objectRow(ctx, user.orgId, spec.lookupTo))?.object) throw new ConvexError(`Unknown object ${spec.lookupTo}`);
    }
    const related = await rollupSource(ctx, user.orgId, spec.compute);
    let created = { fieldId: "", apiName: "" };
    await change(ctx, object, { kind: "field_created" }, (ext, ai) => {
      const out = addField(object, ext, spec, ai, related);
      created = { fieldId: out.field.fieldId, apiName: out.field.apiName };
      return out.ext;
    });
    return created;
  },
});

export const updateFieldDef = mutation({
  args: dataModelUpdateFieldDefArgs,
  returns: v.null(),
  handler: async (ctx, { object, fieldId, unique, ...rest }) => {
    const user = await requireAdmin(ctx);
    const related = await rollupSource(ctx, user.orgId, rest.compute);
    const claimingSince = Date.now();
    const patch = { ...rest, ...(unique === undefined ? {} : { unique: unique ? { claimingSince } : false as const }) } as FieldPatch;
    const next = await change(ctx, object, { kind: "field_updated", fieldId }, (ext, ai) => {
      ownedBy(ext, fieldId, ai);
      return updateField(object, ext, fieldId, patch, related);
    });
    const field = next.customFields.find((f) => f.fieldId === fieldId);
    // On: only when the field starts claiming now (already unique is a no-op). Off: the claims it held are released.
    if (field && unique !== undefined && (!unique || field.uniqueClaiming === claimingSince)) {
      const jobId = await ctx.db.insert("backgroundJobs", {
        orgId: user.orgId, kind: "unique_field", userId: user._id, status: "processing", startedAt: claimingSince, updatedAt: claimingSince,
        title: unique ? `Make ${field.label} unique` : `Stop holding ${field.label} unique`, href: uniqueJobHref(object, fieldId),
        phases: [{ key: unique ? "check" : "release", label: unique ? "Check for duplicates" : "Release values", status: "processing" }],
      });
      await ctx.scheduler.runAfter(0, internal.uniqueFields.run, { orgId: user.orgId, object, fieldId, userId: user._id, jobId, ...(unique ? { claimingSince } : {}) });
    }
    return null;
  },
});

export const setArchived = mutation({
  args: dataModelSetArchivedArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await change(ctx, args.object, { kind: args.archived ? "field_archived" : "field_restored", fieldId: args.fieldId }, (ext, ai) => {
      ownedBy(ext, args.fieldId, ai);
      return args.archived ? archiveField(args.object, ext, args.fieldId, Date.now()) : restoreField(args.object, ext, args.fieldId);
    });
    return null;
  },
});

export const history = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "dataModel.edit")) throw new ConvexError(refusal("dataModel.edit"));
    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ConvexError("Limit must be an integer from 1 to 200");
    const rows = await ctx.db.query("dataModelChanges").withIndex("by_orgId_and_at", (q) => q.eq("orgId", user.orgId)).order("desc").take(limit);
    return Promise.all(rows.map(async (row) => ({ ...row, memberName: (await ctx.db.get(row.userId))?.name ?? "Former member" })));
  },
});
