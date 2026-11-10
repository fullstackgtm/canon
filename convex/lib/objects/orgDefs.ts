/**
 * An org's object definitions from its `objectDefs` rows (CP7d): the one place
 * Convex functions turn an object name into its definition, standard or
 * custom. Callers keep their own errors for an unknown object.
 */
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { resolveOrgObject, STANDARD_OBJECTS, type OrgObjectExtension, type ResolvedObjectDef } from "./registry.ts";
import type { ExistingObject } from "./customObjects.ts";
import { fromStored } from "./validators.ts";

/** Custom objects an org may hold (customObjects.CUSTOM_OBJECTS_MAX) plus every standard object's extension row. */
export const OBJECT_ROWS_MAX = 100;

export async function objectRow(ctx: QueryCtx, orgId: Id<"organizations">, apiName: string): Promise<Doc<"objectDefs"> | null> {
  return ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId).eq("apiName", apiName)).unique();
}

/** The object's definition for the org, or null when there is none (an unknown name, or a custom object the org never made). */
export async function loadOrgObject(ctx: QueryCtx, orgId: Id<"organizations">, apiName: string): Promise<ResolvedObjectDef | null> {
  const row = await objectRow(ctx, orgId, apiName);
  return resolveOrgObject(apiName, row ? fromStored<OrgObjectExtension>(row) : undefined);
}

/** The org's custom objects' rows, archived ones included. */
export async function customObjectRows(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Doc<"objectDefs">[]> {
  const rows = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId)).take(OBJECT_ROWS_MAX);
  return rows.filter((r) => r.object !== undefined);
}

/** Every object's names in the org, standard ones as the org calls them, so a new name can't repeat one. */
export async function objectNames(ctx: QueryCtx, orgId: Id<"organizations">): Promise<ExistingObject[]> {
  const rows = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId)).take(OBJECT_ROWS_MAX);
  const relabeled = new Map(rows.flatMap((r) => (r.labels ? [[r.apiName, r.labels]] : [])));
  return [
    ...Object.values(STANDARD_OBJECTS).map((o) => ({ apiName: o.apiName, ...(relabeled.get(o.apiName) ?? { label: o.label, pluralLabel: o.pluralLabel }) })),
    ...rows.filter((r) => r.object).map((r) => ({ apiName: r.apiName, label: r.object!.label, pluralLabel: r.object!.pluralLabel, ...(r.object!.archivedAt !== undefined ? { archivedAt: r.object!.archivedAt } : {}) })),
  ];
}

/** The apiNames of the org's archived custom objects. */
export async function archivedObjectNames(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Set<string>> {
  return new Set((await customObjectRows(ctx, orgId)).filter((r) => r.object!.archivedAt !== undefined).map((r) => r.apiName));
}
