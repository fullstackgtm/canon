/**
 * Audience snapshots a module took (docs/modules.md, "Audiences"): the people of an audience at one moment, stored a
 * page at a time so a job reads page N of the same members however the audience changes after. Written only by a
 * call's action (lib/modules/recordReadAction.ts), read only by a read plan (lib/modules/canonReads.ts), and deleted
 * `SNAPSHOT_TTL_MS` after they were taken.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { systemScope } from "./lib/modules/scope";

/** How long a snapshot is kept: long enough for every job key that reads it to run, retries included. */
export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Ids one page of an audience's additions carries across to the action. */
const ADDED_PAGE = 2000;
/** Rows one expiry pass deletes before it schedules the next. */
const EXPIRE_BATCH = 50;

export const store = internalMutation({
  args: {
    orgId: v.id("organizations"), moduleId: v.string(), snapshot: v.string(), audienceId: v.optional(v.string()), source: v.optional(v.string()), count: v.number(),
    pages: v.array(v.object({ page: v.number(), ids: v.array(v.string()) })),
  },
  handler: async (ctx, a): Promise<number> => {
    const createdAt = Date.now();
    for (const p of a.pages) {
      await ctx.db.insert("moduleSnapshots", { orgId: a.orgId, moduleId: a.moduleId, snapshot: a.snapshot, page: p.page, audienceId: a.audienceId, source: a.source, count: a.count, ids: p.ids, createdAt });
    }
    if (a.pages.some((p) => p.page === 0)) await ctx.scheduler.runAfter(SNAPSHOT_TTL_MS, internal.moduleSnapshots.expire, { orgId: a.orgId, moduleId: a.moduleId, snapshot: a.snapshot });
    return createdAt;
  },
});

export const expire = internalMutation({
  args: { orgId: v.id("organizations"), moduleId: v.string(), snapshot: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db.query("moduleSnapshots").withIndex("by_orgId_moduleId_snapshot_page", (q) => q.eq("orgId", a.orgId).eq("moduleId", a.moduleId).eq("snapshot", a.snapshot)).take(EXPIRE_BATCH);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === EXPIRE_BATCH) await ctx.scheduler.runAfter(0, internal.moduleSnapshots.expire, a);
  },
});

/** One page of the people added to an audience one at a time (the snapshot's action checks the reader sees each). */
export const addedPage = internalQuery({
  args: { audienceId: v.id("audiences"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a): Promise<{ ids: string[]; next: string | null }> => {
    const page = await ctx.db.query("audienceAdditions").withIndex("by_audienceId_and_contactId", (q) => q.eq("audienceId", a.audienceId)).paginate({ numItems: ADDED_PAGE, cursor: a.cursor });
    return { ids: page.page.map((r) => r.contactId), next: page.isDone ? null : page.continueCursor };
  },
});

export const addedOf = internalQuery({
  args: { orgId: v.id("organizations"), module: v.string(), set: v.string(), parentKey: v.string(), field: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a): Promise<{ ids: string[]; next: string | null }> => {
    const scope = await systemScope(ctx, a.orgId, a.module);
    if (!scope) return { ids: [], next: null };
    const page = await scope.systemSetValues(a.set, a.parentKey, a.field, a.cursor, ADDED_PAGE);
    return { ids: page.values, next: page.next };
  },
});
