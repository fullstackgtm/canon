/**
 * Stage history and time in stage (CP9): every deal's stream read from the
 * ledger, oldest first, folded as the projection folds it
 * (lib/objects/stageHistory.ts). The ledger lives in Convex, so this is the
 * one report Convex computes; the others run on the record service.
 */
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { asEntry, loadDef } from "./objects";
import { requireCaller } from "./records";
import { ownerScope, refuseHiddenUse } from "./lib/access";
import type { LedgerEntry } from "./lib/objects/fold";
import { indexObjectDef, plainObjectDef, type ObjectDef } from "./lib/objects/registry";
import { stageHistoryReport, stageVisits, type StageHistoryReport, type StageVisit } from "./lib/objects/stageHistory";
import { fromStored, toStored } from "./lib/objects/validators";

/** Deal entries one page reads, and one run reads in all; past it the report covers the oldest and says so. */
const PAGE = 4000;
const RUN_MAX = 400_000;

export const dealDef = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => toStored(plainObjectDef(await loadDef(ctx, args.orgId, "deal"))),
});

export const entriesPage = internalQuery({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("ledgerEntries")
      .withIndex("by_orgId_object_observedAt", (q) => q.eq("orgId", args.orgId).eq("object", "deal"))
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map((e) => toStored(asEntry(e))) };
  },
});

export const dealRows = internalQuery({
  args: { orgId: v.id("organizations"), ids: v.array(v.id("canonEntities")) },
  handler: async (ctx, args) => Promise.all(args.ids.map(async (id) => {
    const entity = await ctx.db.get(id);
    const deal = entity?.orgId === args.orgId && entity.projectionTable === "deals" ? await ctx.db.get(entity.projectionId as Id<"deals">) : null;
    return { id, name: deal?.orgId === args.orgId ? deal.name : null, ownerId: deal?.orgId === args.orgId ? deal.primaryRepId ?? null : null };
  })),
});

export type StageHistoryDeal = { id: string; name: string | null; ownerId: string | null; visits: StageVisit[] };

export async function readStageHistory(ctx: ActionCtx, expectedOrgId?: string): Promise<{ deals: StageHistoryDeal[]; now: number; partial: boolean }> {
  const caller = await requireCaller(ctx, { read: true });
  if (expectedOrgId !== undefined && caller.orgId !== expectedOrgId) throw new ConvexError("You can't read that.");
  const orgId = caller.orgId as Id<"organizations">;
  const scope = ownerScope(caller.access, "deal", true) ? await ctx.runQuery(internal.permissions.callerDealScope, {}) : null;
  const visible = scope ? new Set(scope.owners) : null;
  refuseHiddenUse(caller.access, "deal", ["stage"]);
  const def = indexObjectDef(fromStored<ObjectDef>((await ctx.runQuery(internal.stageHistory.dealDef, { orgId })) as never));
  const streams = new Map<string, LedgerEntry[]>();
  let cursor: string | null = null;
  let read = 0;
  let partial = false;
  for (;;) {
    const page: { page: unknown[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.stageHistory.entriesPage, { orgId, paginationOpts: { numItems: PAGE, cursor } });
    for (const raw of page.page) {
      const e = fromStored<LedgerEntry>(raw as never);
      if (visible && !visible.has(e.streamId)) continue;
      const list = streams.get(e.streamId) ?? [];
      list.push(e);
      streams.set(e.streamId, list);
    }
    read += page.page.length;
    if (page.isDone) break;
    if (read >= RUN_MAX) {
      partial = true;
      break;
    }
    cursor = page.continueCursor;
  }
  const deals: StageHistoryDeal[] = [];
  const ids = [...streams.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const rows: Array<{ id: string; name: string | null; ownerId: string | null }> = await ctx.runQuery(internal.stageHistory.dealRows, { orgId, ids: ids.slice(i, i + 500) as Id<"canonEntities">[] });
    for (const row of rows) {
      try {
        deals.push({ ...row, visits: stageVisits(def, streams.get(row.id)!.sort((a, b) => a.version - b.version)) });
      } catch {
        deals.push({ ...row, visits: [] });
      }
    }
  }
  return { deals, now: Date.now(), partial };
}

export const run = action({
  args: {},
  handler: async (ctx): Promise<StageHistoryReport> => {
    const { deals, now, partial } = await readStageHistory(ctx);
    return stageHistoryReport(deals.map((d) => d.visits), now, partial);
  },
});
