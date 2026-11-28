/**
 * Saved list views (CP2b): a named filter, sort, column set and layout for one
 * object. A view is its creator's until shared; a shared view shows for the
 * whole org, and only its creator or an admin can change or delete it.
 */
import { accessFor } from "./permissions";
import { hiddenFields, may, type Access } from "./lib/access";
import { metadataFields } from "./lib/metadataFields";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { normalizeViewSpec, viewSpecProblem } from "./lib/objects/views";
import { listViewDef, type ListFilter } from "./lib/objects/listSpec";
import { isLedgerObjectName, type ResolvedObjectDef } from "./lib/objects/registry";
import { loadOrgObject } from "./lib/objects/orgDefs";
import { viewSpec } from "./lib/objects/validators";
import { relatedPeopleField, type PeopleFilterDefs } from "./lib/objects/peopleFilters";

const NAME_MAX = 80;
/** Views a user may save per object, and views an org may share per object: the list shows them all. */
const VIEWS_MAX = 100;

type ViewSpec = Infer<typeof viewSpec>;

export async function listedDef(ctx: QueryCtx, orgId: Id<"organizations">, object: string): Promise<ResolvedObjectDef> {
  // An org's own objects (custom_<slug>) are in its registry, so views of them work as views of a standard object do.
  const def = isLedgerObjectName(object) ? await loadOrgObject(ctx, orgId, object) : null;
  if (!def) throw new ConvexError(`Unknown object ${object}`);
  // Accounts and contacts list from the register, with its derived columns (objects.describe).
  return listViewDef(object, def);
}

/** An org holds at most this many AI fields (researchAgents.MAX_AGENTS; not imported, researchAgents imports this file). */
const AI_FIELDS_MAX = 50;

/** Columns a contact list shows from AI fields (`custom.<slug>`): display-only, never filtered or sorted by. */
async function displayColumnsOf(ctx: QueryCtx, orgId: Id<"organizations">, object: string): Promise<Set<string>> {
  if (object !== "contact") return new Set();
  const fields = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).take(AI_FIELDS_MAX);
  return new Set(fields.filter((f) => f.entityType === "contact").map((f) => `custom.${f.slug}`));
}

export async function peopleFilterDefs(ctx: QueryCtx, orgId: Id<"organizations">, filter: readonly ListFilter[]): Promise<PeopleFilterDefs> {
  const objects = new Set(filter.flatMap((f) => {
    const related = relatedPeopleField(f.field);
    return related ? [related.relation.object] : [];
  }));
  return Object.fromEntries(await Promise.all([...objects].map(async (object) => [object, await listedDef(ctx, orgId, object)])));
}

function hidesRelatedFilter(access: Access, withheld: Map<string, Set<string>>, name: string) {
  const related = relatedPeopleField(name);
  if (!related) return false;
  const { relation: { object }, field } = related;
  const hidden = (o: string, f: string) => withheld.get(o)?.has(f) || hiddenFields(access, o).includes(f);
  return !may(access, object, "read") || hidden(object, field) || (object === "account" && hidden("contact", "accountId"));
}

/** The spec as it is stored: checked, and with its grouping in `group` only (views.ts normalizeViewSpec). */
async function checkedViewSpec(ctx: QueryCtx, user: Doc<"users">, object: string, spec: ViewSpec): Promise<ViewSpec> {
  const orgId = user.orgId;
  const related = object === "contact" ? await peopleFilterDefs(ctx, orgId, spec.filter) : {};
  if (Object.keys(related).length) {
    const access = await accessFor(ctx, user);
    const withheld = await metadataFields(ctx, orgId, access);
    if (spec.filter.some((f) => hidesRelatedFilter(access, withheld, f.field))) throw new ConvexError("A related filter field is unavailable for your role");
  }
  const problem = viewSpecProblem(await listedDef(ctx, orgId, object), spec, await displayColumnsOf(ctx, orgId, object), related);
  if (problem) throw new ConvexError(problem);
  return normalizeViewSpec(spec);
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) throw new ConvexError(`A view name is 1 to ${NAME_MAX} characters`);
  return trimmed;
}

const visibleTo = (user: Doc<"users">) => (view: Doc<"savedViews">) => view.shared || view.createdBy === user._id;

const sharedViews = (ctx: QueryCtx, orgId: Id<"organizations">, object: string) =>
  ctx.db.query("savedViews").withIndex("by_orgId_object_shared", (q) => q.eq("orgId", orgId).eq("object", object).eq("shared", true));

/** Sharing one more view must keep the org's shared views within what `list` shows. */
async function checkShareQuota(ctx: QueryCtx, orgId: Id<"organizations">, object: string) {
  if ((await sharedViews(ctx, orgId, object).take(VIEWS_MAX)).length >= VIEWS_MAX) {
    throw new ConvexError(`Your team already shares ${VIEWS_MAX} views of this object; unshare one first`);
  }
}

const ownViews = (ctx: QueryCtx, user: Doc<"users">, object: string) =>
  ctx.db.query("savedViews").withIndex("by_orgId_object_createdBy", (q) => q.eq("orgId", user.orgId).eq("object", object).eq("createdBy", user._id));

export const list = query({
  args: { object: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const access = await accessFor(ctx, user);
    const withheld = await metadataFields(ctx, user.orgId, access);
    const ownFields = withheld.get(args.object);
    const own = await ownViews(ctx, user, args.object).take(VIEWS_MAX);
    const shared = await sharedViews(ctx, user.orgId, args.object).take(VIEWS_MAX);
    const byId = new Map([...own, ...shared].map((view) => [view._id, view]));
    return [...byId.values()]
      .map((view) => {
        const filter = view.spec.filter.filter((f) => !ownFields?.has(f.field) && (args.object !== "contact" || !hidesRelatedFilter(access, withheld, f.field)));
        const omitSort = !!view.spec.sort && ownFields?.has(view.spec.sort.field);
        const omittedClauses = view.spec.filter.length - filter.length + Number(omitSort);
        const spec = { ...view.spec, filter };
        if (omitSort) delete spec.sort;
        return { ...(omittedClauses ? { omittedClauses } : {}), _id: view._id, name: view.name, shared: view.shared, spec, mine: view.createdBy === user._id, updatedAt: view.updatedAt };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: { object: v.string(), name: v.string(), shared: v.boolean(), spec: viewSpec },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const spec = await checkedViewSpec(ctx, user, args.object, args.spec);
    if ((await ownViews(ctx, user, args.object).take(VIEWS_MAX)).length >= VIEWS_MAX) throw new ConvexError(`At most ${VIEWS_MAX} saved views per object`);
    if (args.shared) await checkShareQuota(ctx, user.orgId, args.object);
    return ctx.db.insert("savedViews", {
      orgId: user.orgId, object: args.object, name: cleanName(args.name), createdBy: user._id, shared: args.shared, spec, updatedAt: Date.now(),
    });
  },
});

async function ownView(ctx: QueryCtx, viewId: Id<"savedViews">) {
  const user = await requireUser(ctx);
  const view = await ctx.db.get(viewId);
  if (!view || view.orgId !== user.orgId || !visibleTo(user)(view)) throw new ConvexError("View not found");
  if (view.createdBy !== user._id && !can(user, "shared.moderate")) throw new ConvexError(refusal("shared.moderate"));
  return { user, view };
}

export const update = mutation({
  args: { viewId: v.id("savedViews"), name: v.optional(v.string()), shared: v.optional(v.boolean()), spec: v.optional(viewSpec) },
  handler: async (ctx, args) => {
    const { user, view } = await ownView(ctx, args.viewId);
    const spec = args.spec ? await checkedViewSpec(ctx, user, view.object, args.spec) : null;
    if (args.shared && !view.shared) await checkShareQuota(ctx, user.orgId, view.object);
    await ctx.db.patch(view._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.shared !== undefined ? { shared: args.shared } : {}),
      ...(spec ? { spec } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { viewId: v.id("savedViews") },
  handler: async (ctx, args) => {
    const { view } = await ownView(ctx, args.viewId);
    await ctx.db.delete(view._id);
  },
});
