/** Canonical org suppressions. Public administration derives the workspace and requires an actual admin. */
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { accessFor } from "./permissions";
import { normalizeSuppression, SUPPRESSION_KINDS, SUPPRESSION_PURPOSES, SUPPRESSION_SOURCES } from "./lib/suppressions/domain";
import { migrateDncRow, setSuppression, suppressionFor, suppressionRow } from "./lib/suppressions/store";

const kindV = v.union(...SUPPRESSION_KINDS.map((x) => v.literal(x)));
const sourceV = v.union(...SUPPRESSION_SOURCES.map((x) => v.literal(x)));
export const purposeV = v.union(...SUPPRESSION_PURPOSES.map((x) => v.literal(x)));
export const identifiersV = v.object({ email: v.optional(v.string()), phone: v.optional(v.string()), linkedinUrl: v.optional(v.string()) });

async function admin(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);
  const access = await accessFor(ctx, user);
  if (!can(user, "suppressions.manage") || access.preview) throw new ConvexError(refusal("suppressions.manage"));
  return user;
}

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, a) => {
    const user = await admin(ctx);
    const { numItems } = a.paginationOpts;
    if (numItems < 1 || numItems > 100) throw new ConvexError("Read 1 to 100 suppressions per page.");
    const raw = a.paginationOpts.cursor;
    const legacy = raw?.startsWith("legacy:") ?? false;
    if (raw && !legacy && !raw.startsWith("canonical:")) throw new ConvexError("Invalid suppression page.");
    const cursor = raw ? raw.slice(raw.indexOf(":") + 1) || null : null;
    if (!legacy) {
      const page = await ctx.db.query("suppressions").withIndex("by_orgId_and_updatedAt", (q) => q.eq("orgId", user.orgId)).order("desc").paginate({ numItems, cursor });
      return { ...page, isDone: false, continueCursor: page.isDone ? "legacy:" : `canonical:${page.continueCursor}` };
    }
    // Compatibility rows appear in the same admin list, after canonical rows. At most one bounded legacy page per request.
    const page = await ctx.db.query("dialerDoNotCall").withIndex("by_orgId_and_number", (q) => q.eq("orgId", user.orgId)).paginate({ numItems, cursor });
    const rows = [];
    for (const row of page.page) {
      const value = normalizeSuppression("phone", row.number);
      if (!value || await suppressionRow(ctx, user.orgId, "phone", value, "dnc")) continue;
      rows.push({ ...row, kind: "phone" as const, value, source: "dnc" as const, state: "active" as const, updatedAt: row.addedAt });
    }
    return { ...page, page: rows, continueCursor: `legacy:${page.continueCursor}` };
  },
});

export const add = mutation({
  args: { kind: kindV, value: v.string(), source: sourceV, reason: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const user = await admin(ctx);
    return setSuppression(ctx, { ...a, orgId: user.orgId, actor: user._id, state: "active" });
  },
});

export const lift = mutation({
  args: { id: v.union(v.id("suppressions"), v.id("dialerDoNotCall")), reason: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const user = await admin(ctx);
    const row = await ctx.db.get(a.id);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("Suppression not found in this workspace.");
    const identity = "number" in row ? { kind: "phone" as const, value: row.number, source: "dnc" as const } : { kind: row.kind, value: row.value, source: row.source };
    await setSuppression(ctx, { orgId: user.orgId, actor: user._id, ...identity, state: "lifted", reason: a.reason });
  },
});

/** Private identifiers only, resolved by a trusted send path or a caller-scoped record read. Never exposed as an address lookup. */
export const checkIdentifiers = internalQuery({
  args: { orgId: v.id("organizations"), identifiers: v.array(identifiersV), purpose: purposeV },
  handler: async (ctx, a) => {
    if (a.identifiers.length > 100) throw new ConvexError("Check at most 100 recipients at once.");
    return Promise.all(a.identifiers.map((ids) => suppressionFor(ctx, a.orgId, ids, a.purpose)));
  },
});

/** Operator-invoked only, one org and at most 100 legacy rows per transaction. No scheduling or cloud mutation on deploy. */
export const migrateDncPage = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    if (!await ctx.db.get(orgId)) throw new ConvexError("Workspace not found.");
    const state = await ctx.db.query("suppressionMigrations").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
    if (state?.complete) return { complete: true, migrated: state.migrated };
    const page = await ctx.db.query("dialerDoNotCall").withIndex("by_orgId_and_number", (q) => q.eq("orgId", orgId)).paginate({ cursor: state?.cursor ?? null, numItems: 100 });
    for (const row of page.page) await migrateDncRow(ctx, row);
    const values = { cursor: page.isDone ? null : page.continueCursor, complete: page.isDone, migrated: (state?.migrated ?? 0) + page.page.length, updatedAt: Date.now() };
    if (state) await ctx.db.patch(state._id, values);
    else await ctx.db.insert("suppressionMigrations", { orgId, ...values });
    return { complete: values.complete, migrated: values.migrated };
  },
});
