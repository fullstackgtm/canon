/**
 * Who can see and change what (CP14): the stored side of convex/lib/access.ts.
 * `accessFor` is the one place a caller's access is loaded; every read
 * surface asks it, directly in queries or through records.callerContext in
 * actions. Settings, Permissions and Teams edit the rows here; "view as"
 * previews a member's access, read-only.
 */
import { defineRole, GRANTABLE, isBuiltInRole } from "./lib/roles";
import { can, refusal } from "./lib/capabilities";
import { CAPABILITIES } from "../modules/kernel/capabilities.ts";
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import type { OwnerScope } from "./lib/objects/listSpec";
import { accessOf, canSeeRecord, CONFIGURABLE_ROLES, hasOwnerField, hiddenFields, intersectScopes, narrowsReads, ownerScope, permissionOf, refuseNarrowed, unhideableFields, type Access, type ObjectRule, type Role, type RoleKey } from "./lib/access";
import { loadOrgObject } from "./lib/objects/orgDefs";
import { ID } from "./lib/canon/identity";
import { STANDARD_OBJECTS } from "./lib/objects/registry";

/** Teams one workspace reads for visibility; Settings refuses a team past it. */
export const MAX_TEAMS = 100;
const MAX_TEAM_MEMBERS = 200;
/** How long a "view as" preview lasts before it ends by itself. */
export const PREVIEW_MS = 30 * 60 * 1000;

export { hasOwnerField } from "./lib/access";

/** A member's role in a workspace: their membership's, else their home row's; null when they are not in it. */
export async function roleIn(ctx: QueryCtx, user: Doc<"users">, orgId: Id<"organizations">): Promise<RoleKey | null> {
  const membership = await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", user._id).eq("orgId", orgId)).first();
  if (membership) return membership.isActive ? membership.role : null;
  return user.orgId === orgId && user.isActive ? user.role : null;
}

async function accessAs(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">, role: RoleKey, preview?: Access["preview"]): Promise<Access> {
  const row = role === "admin" ? null : await ctx.db.query("rolePermissions").withIndex("by_orgId_and_role", (q) => q.eq("orgId", orgId).eq("role", role)).unique();
  const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(MAX_TEAMS);
  return accessOf({
    userId, role, rules: row?.rules ?? null,
    teams: teams.map((t) => ({ memberIds: t.memberIds, leadId: t.managerId ?? null })),
    ...(preview ? { preview } : {}),
  });
}

/**
 * A caller's access in their active workspace (`user` as getCurrentUser
 * returns it, already scoped to the org). An admin with a live "view as"
 * preview reads as the member they preview, and may write nothing.
 */
export async function accessFor(ctx: QueryCtx, user: Doc<"users">): Promise<Access> {
  if (user.role === "admin") {
    const preview = await ctx.db.query("accessPreviews").withIndex("by_userId_and_orgId", (q) => q.eq("userId", user._id).eq("orgId", user.orgId)).unique();
    if (preview && preview.expiresAt > Date.now()) {
      const target = await ctx.db.get(preview.asUserId);
      const role = target ? await roleIn(ctx, target, user.orgId) : null;
      // A member who left the workspace previews as nobody: a rep with no rules, never the admin's own access.
      return accessAs(ctx, user.orgId, preview.asUserId, role ?? "other", { adminId: user._id, asUserId: preview.asUserId, asName: target?.name ?? "a former member" });
    }
  }
  return accessAs(ctx, user.orgId, user._id, user.role);
}

/**
 * The caller for the analytics pages that read the CRM mirror and deal tables
 * whole (ABM, ICP, hygiene, health, forecasts, summaries): null, as signed
 * out, for a role whose rules narrow what it reads, since those pages do not
 * filter record by record. Full-access roles and admins are unaffected.
 */
export async function unrestrictedUser(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  const access = await accessFor(ctx, user);
  return narrowsReads(access) || access.preview ? null : user;
}

/**
 * Whether the caller sees a record a read resolved from its stream. A deal is
 * judged by its row's `primaryRepId`, the owner every deal surface reads; any
 * other record by its own `ownerId`.
 */
export async function recordVisible(ctx: QueryCtx, access: Access, record: { streamId: string; object: string; values: Record<string, unknown> }): Promise<boolean> {
  if (record.object === "lineItem") return lineItemVisible(ctx, [access], record.values.dealId, (await ctx.db.get(record.streamId as Id<"canonEntities">))?.orgId);
  if (record.object !== "deal") return canSeeRecord(access, record.object, hasOwnerField(record.object), record.values.ownerId ?? null);
  if (!ownerScope(access, "deal", true)) return true;
  const entity = await ctx.db.get(record.streamId as Id<"canonEntities">);
  const dealId = entity?.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  return deal !== null && dealVisible(access, deal);
}

async function lineItemVisible(ctx: QueryCtx, accesses: readonly Access[], parent: unknown, orgId: Id<"organizations"> | undefined): Promise<boolean> {
  if (!orgId || typeof parent !== "string" || !accesses.every((a) => permissionOf(a, "lineItem").read)) return false;
  const id = ctx.db.normalizeId("canonEntities", parent);
  const entity = id ? await ctx.db.get(id) : null;
  const dealId = entity?.orgId === orgId && entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  return deal !== null && deal.orgId === orgId && deal.archivedAt === undefined && accesses.every((a) => dealVisible(a, deal));
}

/**
 * Whether every one of `accesses` sees a Canon entity (CP14), as far as a
 * query or mutation can tell. Every Convex read or write keyed by an entity
 * (facts, answers, receipts, proposals) asks this:
 *
 * - an object no access narrows: seen;
 * - a deal: by its row's `primaryRepId` (dealVisible);
 * - a ledger object: by its hot row's `ownerId`;
 * - a company or person in the record service: Convex does not know its
 *   owner, so the answer is its record-service id, for an action to admit
 *   through a scoped client (lib/scopedRecordClient.ts visibleIds);
 * - a CRM mirror row: judged by the register record it is linked to (one
 *   stream for both); unlinked, not seen, since the mirror's owner is not the
 *   register's (as the mirror analytics pages, unrestrictedUser).
 */
export type EntitySight = { seen: boolean } | PendingSight;

/** The key an action admits a pending sight by: a record-service id, a company's domain or a person's email. */
export const sightKey = (s: PendingSight) => ("recordId" in s ? s.recordId : "domain" in s ? s.domain : s.email);

export async function entitySight(ctx: QueryCtx, accesses: readonly Access[], entity: Doc<"canonEntities">): Promise<EntitySight> {
  const object = entity.entityType === "opportunity" ? "deal" : entity.entityType;
  if (object === "lineItem") {
    const row = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", entity.orgId).eq("streamId", entity._id)).unique();
    return { seen: row !== null && await lineItemVisible(ctx, accesses, row.values.dealId, entity.orgId) };
  }
  const hasOwner = object === "deal" || hasOwnerField(object);
  if (accesses.every((a) => !ownerScope(a, object, hasOwner))) return { seen: true };
  switch (entity.projectionTable) {
    case "deals": {
      const id = ctx.db.normalizeId("deals", entity.projectionId);
      const deal = id ? await ctx.db.get(id) : null;
      return { seen: deal !== null && deal.orgId === entity.orgId && accesses.every((a) => dealVisible(a, deal)) };
    }
    case "recordRows": {
      const row = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", entity.orgId).eq("streamId", entity._id)).unique();
      return { seen: row !== null && accesses.every((a) => canSeeRecord(a, object, hasOwner, row.values.ownerId ?? null)) };
    }
    case "recordAccounts":
    case "recordContacts":
      return object === "account" || object === "contact" ? { object, recordId: entity.projectionId } : { seen: false };
    case "crmAccounts":
    case "crmContacts": {
      // A CRM mirror row linked to a register record (one stream for both) is judged by that record; unlinked, it is not seen.
      if (object !== "account" && object !== "contact") return { seen: false };
      const provider = object === "account" ? ID.recordAccount : ID.recordContact;
      // Linked by its register id, or (as a mirror synced before the register held it) by the domain or email the register matches on.
      const exts = await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", entity._id)).take(20);
      const record = exts.find((e) => e.provider === provider);
      if (record) return { object, recordId: record.externalId };
      const key = exts.find((e) => e.provider === (object === "account" ? ID.domain : ID.email));
      if (!key) return { seen: false };
      return object === "account" ? { object, domain: key.externalId } : { object, email: key.externalId };
    }
    default:
      return { seen: false };
  }
}

/** Whether a sight admits its entity: seen, or a record-service id an action admitted through a scoped client. */
export const sightAdmits = (sight: EntitySight, admitted: ReadonlySet<string>) => ("seen" in sight ? sight.seen : admitted.has(sightKey(sight)));

/**
 * Whether every one of `accesses` sees an entity, judged by a query alone: a
 * company or person only the record service can judge is not admitted, so a
 * role that sees only some of them reads their facts through an action that
 * admits them, or not at all. Fails closed.
 */
export async function querySees(ctx: QueryCtx, accesses: readonly Access[], entity: Doc<"canonEntities">, admitted: ReadonlySet<string> = new Set()): Promise<boolean> {
  return sightAdmits(await entitySight(ctx, accesses, entity), admitted);
}

/**
 * entitySight for a company or person named by its record-service id (a
 * contact's calls and observations, a company's history): seen when no access
 * narrows the object; otherwise the id, for an action to admit.
 */
export function recordSight(accesses: readonly Access[], object: "account" | "contact", recordId: string): EntitySight {
  return accesses.every((a) => !ownerScope(a, object, true)) ? { seen: true } : { object, recordId };
}

/**
 * A company or person a query could not judge, for an action to admit
 * (lib/scopedRecordClient.ts admitThenRead): its record-service id, or a
 * company's domain (signals and heat are keyed by it).
 */
export type PendingSight = { object: "account" | "contact"; recordId: string } | { object: "account"; domain: string } | { object: "contact"; email: string };

/**
 * The judge for a read keyed by many records (a review queue, a batch, a
 * contact's calls): every record goes through entitySight or recordSight, and
 * what only the record service can judge is collected in `pending`. A public
 * query that ends with any pending returns null; its action twin admits the
 * pending ids through the caller's scoped client and reads again with them
 * `admitted`. Fails closed: a pending record is not shown.
 */
export function sightJudge(ctx: QueryCtx, accesses: readonly Access[], admitted: ReadonlySet<string> = new Set()) {
  const pending: PendingSight[] = [];
  const admits = (sight: EntitySight) => {
    if ("seen" in sight) return sight.seen;
    if (admitted.has(sightKey(sight))) return true;
    pending.push(sight);
    return false;
  };
  return {
    pending,
    entity: async (entity: Doc<"canonEntities"> | null) => entity !== null && admits(await entitySight(ctx, accesses, entity)),
    record: (object: "account" | "contact", recordId: string) => admits(recordSight(accesses, object, recordId)),
    /** A company by its domain (lowercased): admitted as the domain itself. */
    domain: (domain: string) => {
      const d = domain.toLowerCase();
      if (accesses.every((a) => !ownerScope(a, "account", true)) || admitted.has(d)) return true;
      pending.push({ object: "account", domain: d });
      return false;
    },
  };
}

/**
 * The signed-in member, for a whole-workspace operation: refused to a role
 * that sees only part of the workspace (lib/access.ts refuseNarrowed). Imports
 * and syncs, plans and scores built from the whole CRM mirror, and their
 * results read as the whole workspace, so only a role that sees all of it runs
 * or reads them.
 */
export async function requireUnrestricted(ctx: QueryCtx, what: string): Promise<Doc<"users">> {
  const user = await requireUser(ctx, { allowPreview: true });
  refuseNarrowed(await accessFor(ctx, user), what);
  return user;
}

/** requireUnrestricted for a CLI token's user (an action has no signed-in identity for it): refused unless an active member who sees the whole workspace. */
export const requireUnrestrictedPrincipal = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), what: v.string() },
  handler: async (ctx, args) => {
    const accesses = await principalAccess(ctx, args.orgId, [args.userId]);
    if (!accesses) throw new ConvexError("This token's user is no longer a member of this workspace");
    refuseNarrowed(accesses[0]!, args.what);
    return null;
  },
});

/** requireUnrestricted for an action's signed-in caller. */
export const requireUnrestrictedCaller = internalQuery({
  args: { what: v.string() },
  handler: async (ctx, args) => {
    await requireUnrestricted(ctx, args.what);
    return null;
  },
});

/** The caller's access, or a refusal: for writes, which a preview never makes. */
export async function requireWriteAccess(ctx: MutationCtx, user: Doc<"users">): Promise<Access> {
  const access = await accessFor(ctx, user);
  if (access.preview) throw new ConvexError(`You are viewing as ${access.preview.asName}: changes are off until you exit the preview`);
  return access;
}

async function requireAdmin(ctx: QueryCtx | MutationCtx, opts: { allowPreview?: boolean } = {}) {
  const user = await requireUser(ctx, opts);
  if (!can(user, "permissions.manage")) throw new ConvexError(refusal("permissions.manage"));
  return user;
}

/** Whether the caller sees a deal (CP14): its owner, `primaryRepId` (the deal's `ownerId`), inside their deal scope. */
export const dealVisible = (access: Access, deal: Pick<Doc<"deals">, "primaryRepId">) => canSeeRecord(access, "deal", true, deal.primaryRepId ?? null);

/**
 * The workspace's newest deals the caller sees, at most `limit`, read by
 * owner from the `[orgId, primaryRepId]` index: each owner's deals, and the
 * deals with no owner when the scope admits them.
 */
export async function visibleDeals(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, limit: number): Promise<Doc<"deals">[]> {
  const scope = ownerScope(access, "deal", true);
  if (!scope) return ctx.db.query("deals").withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", orgId).eq("archivedAt", undefined)).order("desc").take(limit);
  const owners: Array<Id<"users"> | undefined> = scope.owners.flatMap((id) => ctx.db.normalizeId("users", id) ?? []);
  if (scope.unowned) owners.push(undefined);
  const pages = await Promise.all(owners.map((owner) =>
    ctx.db.query("deals").withIndex("by_orgId_and_primaryRepId", (q) => q.eq("orgId", orgId).eq("primaryRepId", owner)).order("desc").take(limit)));
  // An archived deal is left out (deals.archivedAt): owner pages read it, so it is dropped here.
  return pages.flat().filter((d) => d.archivedAt === undefined).sort((a, b) => b._creationTime - a._creationTime).slice(0, limit);
}

/** The most deals a scoped list, search or report over the projection names by id (DEAL_SCOPE_MAX ids in one request). */
export const DEAL_SCOPE_MAX = 5000;

/**
 * A deal scope for the surfaces the record service serves (the generic list,
 * search and reports), or null for every deal. A deal's owner is its row's
 * `primaryRepId`, which CRM sync and the Deals page write and the projection
 * does not always carry, so the scope names the visible deals' record ids
 * rather than an owner column. A role that sees more than DEAL_SCOPE_MAX
 * deals is refused rather than shown a partial list.
 */
export async function dealIdScope(ctx: QueryCtx, orgId: Id<"organizations">, access: Access): Promise<OwnerScope | null> {
  if (!ownerScope(access, "deal", true)) return null;
  if (!permissionOf(access, "deal").read) return { field: "id", owners: [], unowned: false };
  const deals = await visibleDeals(ctx, orgId, access, DEAL_SCOPE_MAX + 1);
  if (deals.length > DEAL_SCOPE_MAX) throw new ConvexError(`Your role sees more than ${DEAL_SCOPE_MAX} deals, more than a scoped list holds; ask an admin to widen it to all deals`);
  const streams = await Promise.all(deals.map((d) =>
    ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", d._id)).first()));
  return { field: "id", owners: streams.flatMap((s) => (s ? [s._id as string] : [])), unowned: false };
}

/**
 * The access of the people an agent run reads and writes as (lib/access.ts
 * agentPrincipals), each with their role in the workspace and its rules. Null
 * when any of them is no longer an active member: that run does not run. An
 * agent never falls back to unrestricted reads.
 */
export async function principalAccess(ctx: QueryCtx, orgId: Id<"organizations">, userIds: readonly string[]): Promise<Access[] | null> {
  const out: Access[] = [];
  for (const raw of userIds) {
    const id = ctx.db.normalizeId("users", raw);
    const user = id ? await ctx.db.get(id) : null;
    const role = user ? await roleIn(ctx, user, orgId) : null;
    if (!id || !role) return null;
    out.push(await accessAs(ctx, orgId, id, role));
  }
  return out.length ? out : null;
}

/**
 * The deals every one of `accesses` sees, as an id scope (dealIdScope), or
 * null for every deal. Record clients read it (records.principalClient), so
 * a read scoped to an agent's principals never depends on who, if anyone, is
 * signed in to the action running it.
 */
export const dealScopeOf = internalQuery({
  // Access objects as lib/access.ts accessOf builds them; internal callers only.
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()) },
  handler: async (ctx, args): Promise<OwnerScope | null> => {
    let scope: OwnerScope | null = null;
    for (const access of args.accesses as Access[]) scope = intersectScopes(scope, await dealIdScope(ctx, args.orgId, access));
    return scope;
  },
});

/** The caller's deal scope, for actions (objects.list, objects.search). */
export const callerDealScope = internalQuery({
  args: {},
  handler: async (ctx): Promise<OwnerScope | null> => {
    const user = await getCurrentUser(ctx);
    return user ? dealIdScope(ctx, user.orgId, await accessFor(ctx, user)) : null;
  },
});

/**
 * A deals row as the caller may read it (CP14): without its hidden fields.
 * The deal's owner field is the row's `primaryRepId`; the names a list adds
 * for it go with it.
 */
export function dealForCaller<D extends Record<string, unknown>>(access: Access, deal: D): D {
  const hidden = hiddenFields(access, "deal");
  if (!hidden.length) return deal;
  const out: Record<string, unknown> = { ...deal };
  for (const f of hidden) {
    if (f === "ownerId") for (const k of ["primaryRepId", "primaryRepName", "primaryRepEmail"]) delete out[k];
    else delete out[f];
  }
  return out as D;
}

// ───────────────────────────── Reads ─────────────────────────────

/** What the caller's own session needs to know: whether a preview is on, and their permission per object for pages to hide what they cannot do. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx).catch(() => null);
    if (!user) return null;
    const access = await accessFor(ctx, user);
    const objects = Object.keys(STANDARD_OBJECTS);
    return {
      role: access.role,
      preview: access.preview ? { asUserId: access.preview.asUserId, asName: access.preview.asName } : null,
      objects: Object.fromEntries(objects.map((o) => [o, permissionOf(access, o)])),
    };
  },
});

const ruleValidator = v.object({
  object: v.string(),
  visibility: v.optional(v.union(v.literal("all"), v.literal("team"), v.literal("own"))),
  unowned: v.optional(v.boolean()),
  read: v.optional(v.boolean()),
  create: v.optional(v.boolean()),
  edit: v.optional(v.boolean()),
  delete: v.optional(v.boolean()),
  fields: v.optional(v.array(v.object({ apiName: v.string(), level: v.union(v.literal("hidden"), v.literal("readOnly")) }))),
});
/** The workspace's own roles (lib/roles.ts). */
export async function orgRolesOf(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Doc<"orgRoles">[]> {
  return await ctx.db.query("orgRoles").withIndex("by_orgId_and_key", (q) => q.eq("orgId", orgId)).take(MAX_ORG_ROLES);
}
const MAX_ORG_ROLES = 50;

/** The base of each of the workspace's own roles, by key (lib/roles.ts baseRole). */
export async function roleBasesOf(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Record<string, string>> {
  return Object.fromEntries((await orgRolesOf(ctx, orgId)).map((r) => [r.key, r.base]));
}

/** A role a member can hold here: a built-in one, or one of the workspace's own. */
export async function requireRoleKey(ctx: QueryCtx, orgId: Id<"organizations">, key: string) {
  if (isBuiltInRole(key)) return;
  const row = await ctx.db.query("orgRoles").withIndex("by_orgId_and_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!row) throw new ConvexError(`There is no role ${key}`);
}

/** Settings, Permissions and Teams: every role's rules, the teams and the members to pick from. Admins only. */
export const settings = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx).catch(() => null);
    if (!user || !can(user, "permissions.manage")) return null;
    const own = await orgRolesOf(ctx, user.orgId);
    const keys = [...CONFIGURABLE_ROLES, ...own.map((r) => r.key)];
    const rows = await Promise.all(keys.map((role) =>
      ctx.db.query("rolePermissions").withIndex("by_orgId_and_role", (q) => q.eq("orgId", user.orgId).eq("role", role)).unique()));
    const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(MAX_TEAMS);
    const members = await workspaceMembers(ctx, user.orgId);
    return {
      roles: keys.map((role, i) => {
        const custom = own.find((r) => r.key === role);
        return { role, rules: rows[i]?.rules ?? [], updatedAt: rows[i]?.updatedAt ?? null, ...(custom ? { custom: { name: custom.name, base: custom.base, capabilities: custom.capabilities } } : {}) };
      }),
      grantable: GRANTABLE.map((key) => ({ key, label: CAPABILITIES[key].label, managers: (CAPABILITIES[key].roles as readonly string[]).includes("manager") })),
      ownedObjects: Object.keys(STANDARD_OBJECTS).filter(hasOwnerField),
      teams: teams.map((t) => ({ id: t._id, name: t.name, leadId: t.managerId ?? null, memberIds: t.memberIds })),
      members,
    };
  },
});

/** Active members of a workspace with their role there: home rows and memberships. */
export async function workspaceMembers(ctx: QueryCtx, orgId: Id<"organizations">) {
  const out = new Map<string, { id: Id<"users">; name: string; email: string; role: RoleKey }>();
  for (const u of await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(500)) {
    if (u.isActive && !u.isHidden) out.set(u._id, { id: u._id, name: u.name, email: u.email, role: u.role });
  }
  for (const m of await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(500)) {
    const u = m.isActive ? await ctx.db.get(m.userId) : null;
    if (u && !u.isHidden) out.set(u._id, { id: u._id, name: u.name, email: u.email, role: m.role });
    else if (!m.isActive) out.delete(m.userId);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ───────────────────────────── Writes (admins, human-only) ─────────────────────────────

/** Add or change one of the workspace's own roles: its name, the built-in role it counts as, and its capabilities. */
export const defineWorkspaceRole = mutation({
  args: { key: v.optional(v.string()), name: v.string(), base: v.string(), capabilities: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const own = await orgRolesOf(ctx, user.orgId);
    const existing = args.key ? own.find((r) => r.key === args.key) : null;
    if (args.key && !existing) throw new ConvexError(`There is no role ${args.key}`);
    if (!existing && own.length >= MAX_ORG_ROLES) throw new ConvexError(`A workspace has at most ${MAX_ORG_ROLES} roles of its own`);
    let role;
    try {
      role = defineRole(args, own, args.key);
    } catch (e) {
      throw new ConvexError((e as Error).message);
    }
    const doc = { ...role, capabilities: [...role.capabilities], updatedAt: Date.now(), updatedBy: user._id };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("orgRoles", { orgId: user.orgId, ...doc });
    return role.key;
  },
});

/** Remove one of the workspace's own roles, and its record rules. Refused while anyone holds it. */
export const removeWorkspaceRole = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const row = (await orgRolesOf(ctx, user.orgId)).find((r) => r.key === args.key);
    if (!row) throw new ConvexError(`There is no role ${args.key}`);
    // Every stored holder, deactivated and hidden ones too: a member reactivated on a deleted role would have no rules.
    const users = (await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000)).filter((u) => u.role === args.key);
    const memberships = (await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000)).filter((m) => m.role === args.key);
    const holders = [...new Set([...users.map((u) => u._id), ...memberships.map((m) => m.userId)])];
    if (holders.length) {
      const names = (await Promise.all(holders.map((id) => ctx.db.get(id)))).map((u) => u?.name ?? "a former member");
      throw new ConvexError(`Give ${names.join(", ")} another role first, including anyone deactivated`);
    }
    const rules = await ctx.db.query("rolePermissions").withIndex("by_orgId_and_role", (q) => q.eq("orgId", user.orgId).eq("role", args.key)).unique();
    if (rules) await ctx.db.delete(rules._id);
    await ctx.db.delete(row._id);
  },
});

/** Replace one role's rules. An object left out keeps full access; an empty list restores today's access for the role. */
export const saveRole = mutation({
  args: { role: v.string(), rules: v.array(ruleValidator) },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    if (args.role === "admin") throw new ConvexError("Admins always have full access");
    await requireRoleKey(ctx, user.orgId, args.role);
    const seen = new Set<string>();
    const rules: ObjectRule[] = [];
    for (const r of args.rules) {
      if (seen.has(r.object)) throw new ConvexError(`${r.object} is listed twice`);
      seen.add(r.object);
      // Team and own visibility read the owner; an object without one is seen whole or not at all.
      if (r.visibility && r.visibility !== "all" && !hasOwnerField(r.object)) throw new ConvexError(`${r.object} records have no owner, so they are seen by all or none`);
      const fields = r.fields ? [...new Map(r.fields.map((f) => [f.apiName, f])).values()] : undefined;
      // A title or a duplicate key shows wherever the record does: it can be read-only, never hidden.
      const def = fields?.some((f) => f.level === "hidden") ? await loadOrgObject(ctx, user.orgId, r.object) : null;
      const title = def?.byFieldId.get(def.titleFieldId)?.apiName;
      const unhideable = new Set(unhideableFields(r.object, title));
      const bad = fields?.find((f) => f.level === "hidden" && unhideable.has(f.apiName));
      if (bad) throw new ConvexError(`${bad.apiName} names or matches ${r.object} records, so it can be read-only but not hidden`);
      rules.push({ ...r, ...(fields ? { fields } : {}) });
    }
    const existing = await ctx.db.query("rolePermissions").withIndex("by_orgId_and_role", (q) => q.eq("orgId", user.orgId).eq("role", args.role)).unique();
    const doc = { orgId: user.orgId, role: args.role, rules, updatedAt: Date.now(), updatedBy: user._id };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("rolePermissions", doc);
    return null;
  },
});

async function checkMembers(ctx: MutationCtx, orgId: Id<"organizations">, ids: readonly Id<"users">[]) {
  if (ids.length > MAX_TEAM_MEMBERS) throw new ConvexError(`A team has at most ${MAX_TEAM_MEMBERS} members`);
  for (const id of ids) {
    const u = await ctx.db.get(id);
    if (!u || !(await roleIn(ctx, u, orgId))) throw new ConvexError("Everyone on a team must be a member of this workspace");
  }
}

const teamArgs = { name: v.string(), leadId: v.optional(v.id("users")), memberIds: v.array(v.id("users")) };

export const createTeam = mutation({
  args: teamArgs,
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const name = args.name.trim().slice(0, 80);
    if (!name) throw new ConvexError("A team needs a name");
    const count = (await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(MAX_TEAMS)).length;
    if (count >= MAX_TEAMS) throw new ConvexError(`A workspace has at most ${MAX_TEAMS} teams`);
    const memberIds = [...new Set(args.memberIds)];
    await checkMembers(ctx, user.orgId, args.leadId ? [...memberIds, args.leadId] : memberIds);
    return ctx.db.insert("teamGroups", { orgId: user.orgId, name, memberIds, createdAt: Date.now(), ...(args.leadId ? { managerId: args.leadId } : {}) });
  },
});

export const updateTeam = mutation({
  args: { teamId: v.id("teamGroups"), ...teamArgs },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== user.orgId) throw new ConvexError("Team not found");
    const name = args.name.trim().slice(0, 80);
    if (!name) throw new ConvexError("A team needs a name");
    const memberIds = [...new Set(args.memberIds)];
    await checkMembers(ctx, user.orgId, args.leadId ? [...memberIds, args.leadId] : memberIds);
    await ctx.db.replace(team._id, { orgId: team.orgId, name, memberIds, createdAt: team.createdAt, ...(args.leadId ? { managerId: args.leadId } : {}) });
    return null;
  },
});

export const removeTeam = mutation({
  args: { teamId: v.id("teamGroups") },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== user.orgId) throw new ConvexError("Team not found");
    await ctx.db.delete(team._id);
    return null;
  },
});

/** Start (or switch) a "view as" preview of a member. Reads resolve as theirs; writes are refused until it ends. */
export const startPreview = mutation({
  args: { asUserId: v.id("users") },
  handler: async (ctx, args) => {
    // Switching whom to view as is allowed mid-preview.
    const user = await requireAdmin(ctx, { allowPreview: true });
    const target = await ctx.db.get(args.asUserId);
    if (!target || target._id === user._id || !(await roleIn(ctx, target, user.orgId))) throw new ConvexError("Pick another member of this workspace");
    const existing = await ctx.db.query("accessPreviews").withIndex("by_userId_and_orgId", (q) => q.eq("userId", user._id).eq("orgId", user.orgId)).unique();
    const doc = { orgId: user.orgId, userId: user._id, asUserId: target._id, expiresAt: Date.now() + PREVIEW_MS };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("accessPreviews", doc);
    return null;
  },
});

export const stopPreview = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx, { allowPreview: true });
    const existing = await ctx.db.query("accessPreviews").withIndex("by_userId_and_orgId", (q) => q.eq("userId", user._id).eq("orgId", user.orgId)).unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
