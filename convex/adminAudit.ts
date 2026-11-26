import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { adminEvents } from "./lib/modules/scope";
import { activeRoleIn } from "./lib/membership";
import type { Id } from "./_generated/dataModel";

const sources = ["operations", "modules", "dataModel"] as const;
type Source = typeof sources[number];
export type AuditRow = {
  id: string; source: Source; at: number; actorId: string | null; actor: string;
  operation: string; target: string; fields: Record<string, string | number | string[]>;
};
type Page = { page: AuditRow[]; isDone: boolean; continueCursor: string };

/** Where a page ended: its last row's time, and the ids already returned at that exact time. */
type Cursor = { at: number; seen: string[] };
/** Rows one mutation writes share a timestamp; a cursor carries their ids so none repeats or is skipped. */
const TIE_MAX = 500;

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!c || Array.isArray(c) || typeof c !== "object" || !Number.isFinite(c.at) || !Array.isArray(c.seen) || c.seen.length > TIE_MAX || c.seen.some((id: unknown) => typeof id !== "string")) throw new Error();
    return { at: c.at, seen: c.seen };
  } catch { throw new ConvexError("Invalid audit cursor"); }
}

// Convex allows one paginated query per function, nested queries included, and this list reads three tables.
// So each table is read newest first with a bounded take from the cursor's time, and the cursor is ours.
export const list = query({
  args: { paginationOpts: paginationOptsValidator, actorId: v.optional(v.string()), operation: v.optional(v.string()), start: v.optional(v.number()), end: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Page> => {
    const user = await requireUser(ctx);
    if (!can(user, "permissions.manage")) throw new ConvexError(refusal("permissions.manage"));
    if (args.start !== undefined && args.end !== undefined && args.start > args.end) throw new ConvexError("Invalid date range");
    const n = args.paginationOpts.numItems;
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new ConvexError("Page size must be between 1 and 50");
    const cursor = parseCursor(args.paginationOpts.cursor);
    const seen = new Set(cursor?.seen ?? []);
    const start = args.start ?? 0, end = Math.min(args.end ?? Number.MAX_SAFE_INTEGER, cursor?.at ?? Number.MAX_SAFE_INTEGER);
    // One more than a page needs, past the rows already returned at the cursor's time, shows whether more remain.
    const take = n + seen.size + 1;
    const memberName = async (id: Id<"users"> | undefined) => {
      const member = id ? await ctx.db.get(id) : null;
      return member && await activeRoleIn(ctx, member, user.orgId) ? member.name : id ? "Former member" : "System";
    };
    const scopedActorId = async (id: Id<"users"> | undefined) => {
      const member = id ? await ctx.db.get(id) : null;
      return member && await activeRoleIn(ctx, member, user.orgId) ? member._id : null;
    };
    const [operations, modules, dataModel] = await Promise.all([
      ctx.db.query("operationAuditLog").withIndex("by_orgId_and_createdAt", q => q.eq("orgId", user.orgId).gte("createdAt", start).lte("createdAt", end)).order("desc").take(take),
      adminEvents(ctx, start, end, take),
      ctx.db.query("dataModelChanges").withIndex("by_orgId_and_at", q => q.eq("orgId", user.orgId).gte("at", start).lte("at", end)).order("desc").take(take),
    ]);
    const candidates: Array<{ id: string; source: Source; at: number; row: () => Promise<AuditRow> }> = [
      ...operations.map(r => ({ id: r._id as string, source: "operations" as const, at: r.createdAt, row: async (): Promise<AuditRow> => ({ id: r._id, source: "operations", at: r.createdAt, actorId: await scopedActorId(r.userId), actor: await memberName(r.userId), operation: r.operation, target: r.patchPlanId ?? r.agentId ?? "Workspace", fields: { verb: r.verb, status: r.status } }) })),
      ...modules.map(r => ({ id: r._id as string, source: "modules" as const, at: r.at, row: async (): Promise<AuditRow> => {
        const actorId = r.actor.kind === "user" || r.actor.kind === "agent" ? r.actor.userId : null;
        const name = await memberName(actorId ?? undefined);
        return { id: r._id, source: "modules", at: r.at, actorId: await scopedActorId(actorId ?? undefined), actor: r.actor.kind === "agent" ? `${r.actor.client ?? "Agent"} (${name})` : r.actor.kind === "visitor" ? "Visitor" : name, operation: r.verb, target: `${r.moduleId}/${r.collection}/${r.key}`, fields: { kind: r.kind, fields: r.fields, ...(r.fromVersion === undefined ? {} : { fromVersion: r.fromVersion }), ...(r.toVersion === undefined ? {} : { toVersion: r.toVersion }) } };
      } })),
      ...dataModel.map(r => ({ id: r._id as string, source: "dataModel" as const, at: r.at, row: async (): Promise<AuditRow> => ({ id: r._id, source: "dataModel", at: r.at, actorId: await scopedActorId(r.userId), actor: `${r.agent ? `${r.agent} (` : ""}${await memberName(r.userId)}${r.agent ? ")" : ""}`, operation: r.kind, target: r.object, fields: { ...(r.fieldId ? { fieldId: r.fieldId } : {}), ...(r.registryVersion === undefined ? {} : { registryVersion: r.registryVersion }) } }) })),
    ].filter(c => !seen.has(c.id));
    candidates.sort((a, b) => b.at - a.at || sources.indexOf(a.source) - sources.indexOf(b.source) || (a.id < b.id ? -1 : 1));
    const selected = candidates.slice(0, n);
    const last = selected[selected.length - 1];
    const next: Cursor | null = last ? { at: last.at, seen: [...(cursor?.at === last.at ? cursor.seen : []), ...selected.filter(c => c.at === last.at).map(c => c.id)] } : cursor;
    if (next && next.seen.length > TIE_MAX) throw new ConvexError("Too many entries share one moment to page through. Narrow the date range.");
    const page = await Promise.all(selected.map(c => c.row()));
    return {
      page: page.filter(r => (!args.actorId || r.actorId === args.actorId) && (!args.operation || r.operation === args.operation)),
      isDone: candidates.length <= n,
      continueCursor: next ? JSON.stringify(next) : "",
    };
  },
});
