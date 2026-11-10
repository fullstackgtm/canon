/**
 * Custom objects (CP7d): an admin creates, renames and archives the org's own
 * objects (lib/objects/customObjects.ts). Fields are added with the field
 * builder (convex/dataModel.ts), which serves a custom object as it serves a
 * standard one. Everything the registry drives (list views, saved views,
 * record pages, bulk edit, the recycle bin, search, the API, webhooks) reads
 * the object from `objects.describe` and `orgObjectDefs`, so none of it has
 * per-object code. A change bumps `registryVersion` and nudges the record
 * service, whose projector builds the object's `p_custom_<slug>` table.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { scheduleNudge } from "./ledgerFeed";
import { editObject, newObject, setObjectArchived, type ExistingObject } from "./lib/objects/customObjects";
import { customObjectRows, objectNames, objectRow } from "./lib/objects/orgDefs";
import { OBJECT_ICONS, RegistryError, type OrgObjectExtension } from "./lib/objects/registry";
import { fromStored, toStored } from "./lib/objects/validators";

async function requireAdmin(ctx: MutationCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!can(user, "dataModel.edit")) throw new ConvexError(refusal("dataModel.edit"));
  return user;
}


/** Run a pure change, turning its RegistryError into one a caller can read. */
function guarded<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof RegistryError) throw new ConvexError(e.message);
    throw e;
  }
}

/** The caller's workspace's own objects, live then archived, with the icon of each, for the nav and the Data model page. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await customObjectRows(ctx, user.orgId);
    // `lookups`: the live lookup fields, so a company, person or deal page can list the records that point at it.
    const lookups = (r: Doc<"objectDefs">) => r.customFields.flatMap((f) => (f.type === "lookup" && f.archivedAt === undefined ? [{ apiName: f.apiName, label: f.label, lookupTo: f.lookupTo }] : []));
    const view = (r: Doc<"objectDefs">) => ({ apiName: r.apiName, label: r.object!.label, pluralLabel: r.object!.pluralLabel, icon: r.object!.icon, archived: r.object!.archivedAt !== undefined, lookups: lookups(r) });
    return [...rows.filter((r) => r.object!.archivedAt === undefined), ...rows.filter((r) => r.object!.archivedAt !== undefined)].map(view);
  },
});

/**
 * Custom objects imported from Salesforce (describe-driven, `isCustom`, sync on): listed on the Data model page, read only. Their
 * records live in the record service's generic tables, not the ledger; Salesforce owns the schema.
 */
export const salesforceObjects = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db.query("objectDefinitions")
      .withIndex("by_orgId_and_provider_and_apiName", (q) => q.eq("orgId", user.orgId).eq("provider", "salesforce")).take(2000);
    return rows.filter((r) => r.isCustom && r.syncEnabled).map((r) => ({ apiName: r.apiName, label: r.label, recordCount: r.recordCount ?? null }));
  },
});

/** Create an object: its names, an icon, and the label of its primary name field. Returns its stable apiName (`custom_<slug>`). */
export const create = mutation({
  args: { label: v.string(), pluralLabel: v.string(), icon: v.union(...OBJECT_ICONS.map((i) => v.literal(i))), titleLabel: v.string() },
  returns: v.object({ apiName: v.string() }),
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const names = await objectNames(ctx, user.orgId);
    const made = guarded(() => newObject(args, names));
    await ctx.db.insert("objectDefs", {
      orgId: user.orgId, apiName: made.apiName, registryVersion: made.ext.registryVersion, object: made.ext.object!,
      customFields: toStored(made.ext.customFields), updatedAt: Date.now(),
    });
    await scheduleNudge(ctx, user.orgId);
    return { apiName: made.apiName };
  },
});

async function changeObject(ctx: MutationCtx, apiName: string, run: (ext: OrgObjectExtension, existing: ExistingObject[]) => OrgObjectExtension) {
  const user = await requireAdmin(ctx);
  const row = await objectRow(ctx, user.orgId, apiName);
  if (!row?.object) throw new ConvexError(`Unknown object ${apiName}`);
  const existing = await objectNames(ctx, user.orgId);
  const next = guarded(() => run(fromStored<OrgObjectExtension>(row), existing));
  await ctx.db.patch(row._id, { registryVersion: next.registryVersion, object: next.object!, updatedAt: Date.now() });
  await scheduleNudge(ctx, user.orgId);
}

/** Rename an object's labels or change its icon. Its apiName, fields and records are untouched. */
export const edit = mutation({
  args: { apiName: v.string(), label: v.optional(v.string()), pluralLabel: v.optional(v.string()), icon: v.optional(v.union(...OBJECT_ICONS.map((i) => v.literal(i)))) },
  returns: v.null(),
  handler: async (ctx, { apiName, ...patch }) => {
    await changeObject(ctx, apiName, (ext, existing) => editObject(apiName, ext, patch, existing));
    return null;
  },
});

/** Archive an object (hidden from the nav, search and the API; records and history kept) or restore it. */
export const setArchived = mutation({
  args: { apiName: v.string(), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { apiName, archived }) => {
    await changeObject(ctx, apiName, (ext, existing) => setObjectArchived(ext, archived, Date.now(), existing, apiName));
    return null;
  },
});
