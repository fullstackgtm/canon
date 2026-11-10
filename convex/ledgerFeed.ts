/**
 * The ledger feed for the record service's projector (docs/cp0-object-layer.md,
 * migration step 6). convex/http.ts serves these queries as `/ledger/tail`,
 * `/ledger/heads` and `/ledger/stream` behind RECORD_SERVICE_TOKEN; `nudge` runs
 * after every save that appended to the ledger and tells the service which
 * shards moved.
 */
import { v } from "convex/values";
import { internalAction, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { recordClient } from "./lib/recordClient";
import { OBJECT_ROWS_MAX } from "./lib/objects/orgDefs";
import { associationObjectDef, plainObjectDef, resolveObjectDef, resolveOrgObject, STANDARD_OBJECTS, type ObjectDef, type OrgObjectExtension, type StandardObjectName } from "./lib/objects/registry";
import { boundedPage, tailPage, type HeadsResponse, type TailResponse, type WireEntry } from "./lib/objects/tail";
import { fromStored } from "./lib/objects/validators";
import { SHARDS } from "./lib/objects/write";

const wireEntry = (e: Doc<"ledgerEntries">): WireEntry => ({
  streamId: e.streamId, version: e.version, observedAt: e.observedAt, source: e.source, actor: e.actor,
  body: fromStored<WireEntry["body"]>(e.body), object: e.object, shard: e.shard, seq: e.seq,
  ...(e.redactedAt !== undefined ? { redactedAt: e.redactedAt } : {}),
});

/** Map an index range to wire entries as it is read, so a bounded page reads only what it returns. */
async function* wireEntries(rows: AsyncIterable<Doc<"ledgerEntries">>): AsyncGenerator<WireEntry> {
  for await (const row of rows) yield wireEntry(row);
}

/** Every ledger object's definition as this org has it (standard fields plus its custom fields and picklists), its own custom objects (archived ones too: the projection keeps them), and the edge streams' (CP3). */
export async function orgObjectDefs(ctx: QueryCtx, orgId: Id<"organizations">): Promise<ObjectDef[]> {
  const rows = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId)).take(OBJECT_ROWS_MAX);
  const ext = new Map(rows.map((r) => [r.apiName, fromStored<OrgObjectExtension>(r)]));
  const own = rows.flatMap((r) => (r.object ? [resolveOrgObject(r.apiName, ext.get(r.apiName))] : []));
  return (Object.keys(STANDARD_OBJECTS) as StandardObjectName[])
    .filter((o) => STANDARD_OBJECTS[o].storage === "ledger")
    .map((o) => plainObjectDef(resolveObjectDef(STANDARD_OBJECTS[o], ext.get(o))))
    .concat(own.flatMap((d) => (d ? [plainObjectDef(d)] : [])))
    .concat(plainObjectDef(associationObjectDef()));
}

/** The last issued `seq` of each shard that has one. */
export async function shardHeads(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Record<string, number>> {
  const rows = await ctx.db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId)).take(SHARDS);
  return Object.fromEntries(rows.map((r) => [String(r.shard), r.seq]));
}

export const tail = internalQuery({
  args: { org: v.string(), shard: v.number(), after: v.number(), limit: v.number() },
  handler: async (ctx, args): Promise<TailResponse | null> => {
    const orgId = ctx.db.normalizeId("organizations", args.org);
    if (!orgId) return null;
    // Bounded by bytes as well as count; the projector continues from the last entry's seq.
    const page = await boundedPage(wireEntries(ctx.db.query("ledgerEntries")
      .withIndex("by_orgId_shard_seq", (q) => q.eq("orgId", orgId).eq("shard", args.shard).gt("seq", args.after))), { limit: args.limit });
    const head = await ctx.db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId).eq("shard", args.shard)).unique();
    return tailPage(page.items, args.after, head?.seq ?? 0);
  },
});

export const heads = internalQuery({
  args: { org: v.string() },
  handler: async (ctx, args): Promise<HeadsResponse | null> => {
    const orgId = ctx.db.normalizeId("organizations", args.org);
    return orgId ? { heads: await shardHeads(ctx, orgId), defs: await orgObjectDefs(ctx, orgId) } : null;
  },
});

export const shardHeadsOf = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => shardHeads(ctx, args.orgId),
});

/** One stream's entries from `fromVersion`, for the projector to fill a version gap. Only streams in `org`. */
export const stream = internalQuery({
  args: { org: v.string(), id: v.string(), fromVersion: v.number(), limit: v.number() },
  handler: async (ctx, args): Promise<{ entries: WireEntry[]; done: boolean } | null> => {
    const orgId = ctx.db.normalizeId("organizations", args.org);
    const streamId = ctx.db.normalizeId("canonEntities", args.id);
    const entity = streamId && (await ctx.db.get(streamId));
    if (!orgId || !entity || entity.orgId !== orgId) return null;
    // Bounded by bytes as well as count; the projector continues from the last entry's version.
    const page = await boundedPage(wireEntries(ctx.db.query("ledgerEntries")
      .withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id).gte("version", args.fromVersion))), { limit: args.limit });
    return { entries: page.items, done: !page.more };
  },
});

/**
 * Tell the record service the org's ledger moved, with its current shard
 * heads, so it pulls only the shards it is behind on. Fire and forget: the
 * service answers before applying, and its poll covers a nudge that is lost.
 */
export const nudge = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<void> => {
    const client = recordClient();
    if (client.mode !== "http") return;
    // CONVEX_SITE_URL is set by Convex itself; sending it means the service needs no configuration to pull from us.
    await client.nudgeProjector(args.orgId, await ctx.runQuery(internal.ledgerFeed.shardHeadsOf, { orgId: args.orgId }), process.env.CONVEX_SITE_URL);
  },
});

/**
 * Schedule one nudge per org per transaction, after the first entry it
 * appends (save step 9). Only when a record service is configured: without
 * one, lists come from the fake over hot rows.
 */
const nudged = new WeakMap<MutationCtx, Set<string>>();
export async function scheduleNudge(ctx: MutationCtx, orgId: Id<"organizations">) {
  if (!process.env.RECORD_SERVICE_URL || !process.env.RECORD_SERVICE_TOKEN) return;
  const orgs = nudged.get(ctx) ?? new Set<string>();
  nudged.set(ctx, orgs);
  if (orgs.has(orgId)) return;
  orgs.add(orgId);
  await ctx.scheduler.runAfter(0, internal.ledgerFeed.nudge, { orgId });
}
