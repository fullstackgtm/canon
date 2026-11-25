import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { adminEventPage } from "./lib/modules/scope";
import { activeRoleIn } from "./lib/membership";
import type { Id } from "./_generated/dataModel";

const sources = ["operations", "modules", "dataModel"] as const;
const sourceV = v.union(v.literal("operations"), v.literal("modules"), v.literal("dataModel"));
type Source = typeof sources[number];
export type AuditRow = {
  id: string; source: Source; at: number; actorId: string | null; actor: string;
  operation: string; target: string; fields: Record<string, string | number | string[]>;
};
type Page = { page: AuditRow[]; isDone: boolean; continueCursor: string };

// Each source owns a native Convex cursor. Nested queries allow independent pagination without copying log data.
export const sourcePage = internalQuery({
  args: { source: sourceV, paginationOpts: paginationOptsValidator, start: v.optional(v.number()), end: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Page> => {
    const user = await requireUser(ctx);
    if (!can(user, "permissions.manage")) throw new ConvexError(refusal("permissions.manage"));
    const memberName = async (id: Id<"users"> | undefined) => {
      const member = id ? await ctx.db.get(id) : null;
      return member && await activeRoleIn(ctx, member, user.orgId) ? member.name : id ? "Former member" : "System";
    };
    const scopedActorId = async (id: Id<"users"> | undefined) => {
      const member = id ? await ctx.db.get(id) : null;
      return member && await activeRoleIn(ctx, member, user.orgId) ? member._id : null;
    };
    const start = args.start ?? 0, end = args.end ?? Number.MAX_SAFE_INTEGER;
    if (args.source === "operations") {
      const result = await ctx.db.query("operationAuditLog").withIndex("by_orgId_and_createdAt", q => q.eq("orgId", user.orgId).gte("createdAt", start).lte("createdAt", end)).order("desc").paginate(args.paginationOpts);
      return { ...result, page: await Promise.all(result.page.map(async r => ({ id: r._id, source: args.source, at: r.createdAt, actorId: await scopedActorId(r.userId), actor: await memberName(r.userId), operation: r.operation, target: r.patchPlanId ?? r.agentId ?? "Workspace", fields: { verb: r.verb, status: r.status } }))) };
    }
    if (args.source === "modules") {
      const result = await adminEventPage(ctx, args.paginationOpts, start, end);
      return { ...result, page: await Promise.all(result.page.map(async r => {
        const actorId = r.actor.kind === "user" || r.actor.kind === "agent" ? r.actor.userId : null;
        const name = await memberName(actorId ?? undefined);
        return { id: r._id, source: args.source, at: r.at, actorId: await scopedActorId(actorId ?? undefined), actor: r.actor.kind === "agent" ? `${r.actor.client ?? "Agent"} (${name})` : r.actor.kind === "visitor" ? "Visitor" : name, operation: r.verb, target: `${r.moduleId}/${r.collection}/${r.key}`, fields: { kind: r.kind, fields: r.fields, ...(r.fromVersion === undefined ? {} : { fromVersion: r.fromVersion }), ...(r.toVersion === undefined ? {} : { toVersion: r.toVersion }) } };
      })) };
    }
    const result = await ctx.db.query("dataModelChanges").withIndex("by_orgId_and_at", q => q.eq("orgId", user.orgId).gte("at", start).lte("at", end)).order("desc").paginate(args.paginationOpts);
    return { ...result, page: await Promise.all(result.page.map(async r => ({ id: r._id, source: args.source, at: r.at, actorId: await scopedActorId(r.userId), actor: `${r.agent ? `${r.agent} (` : ""}${await memberName(r.userId)}${r.agent ? ")" : ""}`, operation: r.kind, target: r.object, fields: { ...(r.fieldId ? { fieldId: r.fieldId } : {}), ...(r.registryVersion === undefined ? {} : { registryVersion: r.registryVersion }) } }))) };
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator, actorId: v.optional(v.string()), operation: v.optional(v.string()), start: v.optional(v.number()), end: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Page> => {
    const user = await requireUser(ctx);
    if (!can(user, "permissions.manage")) throw new ConvexError(refusal("permissions.manage"));
    if (args.start !== undefined && args.end !== undefined && args.start > args.end) throw new ConvexError("Invalid date range");
    const n = args.paginationOpts.numItems;
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new ConvexError("Page size must be between 1 and 50");
    let cursors: Partial<Record<Source, string | null>> = {};
    if (args.paginationOpts.cursor) {
      try {
        const parsed = JSON.parse(args.paginationOpts.cursor);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || sources.some(s => parsed[s] !== undefined && parsed[s] !== null && typeof parsed[s] !== "string")) throw new Error();
        cursors = parsed;
      } catch { throw new ConvexError("Invalid audit cursor"); }
    }
    const read = (source: Source, numItems: number): Promise<Page> => ctx.runQuery(internal.adminAudit.sourcePage, { source, start: args.start, end: args.end, paginationOpts: { cursor: cursors[source] ?? null, numItems } });
    const pages = await Promise.all(sources.map(s => read(s, n)));
    const merged = pages.flatMap(p => p.page).sort((a, b) => b.at - a.at || sources.indexOf(a.source) - sources.indexOf(b.source));
    const selected = merged.slice(0, n);
    let isDone = true;
    for (const [i, source] of sources.entries()) {
      const consumed = selected.filter(r => r.source === source).length;
      if (consumed) {
        const page = consumed === pages[i].page.length ? pages[i] : await read(source, consumed);
        cursors[source] = page.continueCursor;
      }
      if (!pages[i].isDone || consumed < pages[i].page.length) isDone = false;
    }
    return { page: selected.filter(r => (!args.actorId || r.actorId === args.actorId) && (!args.operation || r.operation === args.operation)), isDone, continueCursor: JSON.stringify(cursors) };
  },
});
