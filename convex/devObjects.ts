/**
 * Local-stack proof for the object layer (CP1c): a round trip through the
 * public API and the import and contention measurements recorded in
 * docs/cp0-object-layer.md. Internal and refused unless demo data is enabled,
 * as devSeed is.
 */
import { ConvexError, v } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { DEV_ORG_CLERK_ID, DEV_USER_CLERK_ID, isDevAuthBypassEnabled } from "./lib";
import { STANDARD_OBJECTS, resolveObjectDef } from "./lib/objects/registry";
import { save, shardOf, SHARDS, type SaveResult } from "./lib/objects/write";
import { DEAL_ATTRIBUTES } from "./lib/canon/attributes";
import { convexObjectStore } from "./objects";
import { recordClient } from "./lib/recordClient";
import { clientFor } from "./records";

function requireDev() {
  if (!isDevAuthBypassEnabled()) throw new ConvexError("devObjects runs on local stacks only");
}

export const devCaller = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ orgId: Id<"organizations">; userId: Id<"users"> }> => {
    requireDev();
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Seed the demo workspace first");
    return { orgId: org._id, userId: user._id };
  },
});

/** One user save, as `objects.write` does it, timed inside the transaction. */
export const benchSave = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.id("canonEntities"), company: v.string() },
  handler: async (ctx, args): Promise<string> => {
    requireDev();
    const result = await save(convexObjectStore(ctx), {
      orgId: args.orgId, def: resolveObjectDef(STANDARD_OBJECTS.lead), source: { kind: "user", ref: `user:${args.userId}` },
      actor: { kind: "user", id: args.userId }, now: Date.now(),
    }, { op: "update", streamId: args.streamId, values: { company: args.company } });
    return result.status;
  },
});

/** Create, edit, conflict, unchanged, proposal, delete and restore through the public functions. */
type RoundTrip = { steps: Record<string, string>; record: Record<string, unknown> | null; history: string[] };
type SaveTimings = { saves: number; p50: number; p95: number; max: number; wallP50: number };
type Bench = {
  import: { records: number; seconds: number; recordsPerSecond: number; batchMs: { p50: number; p95: number; max: number }; emptyBatchMs: number };
  replay: { records: number; unchanged: number; ms: number };
  contention: { sameShard: SaveTimings & { streams: number }; differentShards: SaveTimings & { streams: number } };
};

export const roundTrip = internalAction({
  args: {},
  handler: async (ctx): Promise<RoundTrip> => {
    requireDev();
    const created: SaveResult = await ctx.runMutation(api.objects.write, { object: "lead", values: { lastName: "Lovelace", company: "Analytical Engines" } });
    if (created.status !== "applied") throw new ConvexError(`create returned ${created.status}`);
    const streamId = created.streamId as Id<"canonEntities">;
    const steps = {
      create: created.status,
      edit: (await ctx.runMutation(api.objects.write, { object: "lead", streamId, values: { status: "working" }, expectedVersion: 1 })).status,
      conflict: (await ctx.runMutation(api.objects.write, { object: "lead", streamId, values: { status: "qualified" }, expectedVersion: 1 })).status,
      unchanged: (await ctx.runMutation(api.objects.write, { object: "lead", streamId, values: { status: "working" } })).status,
      proposal: (await ctx.runMutation(api.objects.write, { object: "lead", streamId, values: { title: "Countess" }, sourceKind: "enrichment", evidence: "biography" })).status,
      missingRequired: (await ctx.runMutation(api.objects.write, { object: "task", values: { description: "no subject" } })).status,
      remove: (await ctx.runMutation(api.objects.remove, { object: "lead", streamId })).status,
      restore: (await ctx.runMutation(api.objects.restore, { object: "lead", streamId })).status,
    };
    const record: FunctionReturnType<typeof api.objects.get> = await ctx.runQuery(api.objects.get, { streamId });
    const history: FunctionReturnType<typeof api.objects.history> = await ctx.runQuery(api.objects.history, { streamId, paginationOpts: { numItems: 10, cursor: null } });
    return {
      steps,
      record: record && { version: record.version, hot: record.hot, lifecycle: record.lifecycle.status, status: record.values.status, title: record.values.title },
      history: history.page.map((e) => `${e.version}:${e.body.kind === "lifecycle" ? e.body.op : e.body.kind}${e.body.kind === "assert" ? `/${e.body.status}` : ""}@${e.shard}#${e.seq}`),
    };
  },
});

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/**
 * Import `total` leads in batches of 100 and time each batch, then time 16
 * concurrent single saves on one shard against 16 on 16 different shards.
 */
export const bench = internalAction({
  args: { total: v.optional(v.number()), rounds: v.optional(v.number()), parallel: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Bench> => {
    requireDev();
    const { orgId, userId }: { orgId: Id<"organizations">; userId: Id<"users"> } = await ctx.runQuery(internal.devObjects.devCaller, {});
    const total = args.total ?? 5000;
    const sourceRef = `bench:${Date.now()}`;
    const batchMs: number[] = [];
    const streamIds: Id<"canonEntities">[] = [];
    const started = Date.now();
    const offsets = Array.from({ length: Math.ceil(total / 100) }, (_, b) => b * 100);
    const importOne = async (offset: number) => {
      const records = Array.from({ length: Math.min(100, total - offset) }, (_, i) => ({
        externalId: `lead-${offset + i}`,
        values: { firstName: "Bench", lastName: `Lead ${offset + i}`, company: `Company ${(offset + i) % 997}`, email: `lead${offset + i}@example.com`, status: "new" },
        createdAt: 1_700_000_000_000 + offset + i,
        validFrom: 1_700_000_000_000,
      }));
      const t = Date.now();
      const { results }: { results: Array<{ externalId: string; result: SaveResult }> } = await ctx.runMutation(internal.objects.importBatch, { orgId, object: "lead", sourceRef, actorId: "bench", records });
      batchMs.push(Date.now() - t);
      for (const r of results) if (r.result.status === "applied") streamIds.push(r.result.streamId as Id<"canonEntities">);
    };
    // `parallel` batches in flight at once; every batch bumps most of the 16 shard heads, so they contend.
    const parallel = args.parallel ?? 1;
    for (let i = 0; i < offsets.length; i += parallel) await Promise.all(offsets.slice(i, i + parallel).map(importOne));
    const importSeconds = (Date.now() - started) / 1000;
    const emptyStart = Date.now();
    await ctx.runMutation(internal.objects.importBatch, { orgId, object: "lead", sourceRef, actorId: "bench", records: [] });
    const emptyBatchMs = Date.now() - emptyStart;

    const replayStart = Date.now();
    const { results: replay }: { results: Array<{ externalId: string; result: SaveResult }> } = await ctx.runMutation(internal.objects.importBatch, {
      orgId, object: "lead", sourceRef, actorId: "bench",
      records: Array.from({ length: 100 }, (_, i) => ({
        externalId: `lead-${i}`,
        values: { firstName: "Bench", lastName: `Lead ${i}`, company: `Company ${i % 997}`, email: `lead${i}@example.com`, status: "new" },
        validFrom: 1_700_000_000_000,
      })),
    });
    const replayMs = Date.now() - replayStart;

    const byShard = new Map<number, Id<"canonEntities">[]>();
    for (const id of streamIds) byShard.set(shardOf(id), [...(byShard.get(shardOf(id)) ?? []), id]);
    const sameShard = (byShard.get(0) ?? []).slice(0, 16);
    const spread = Array.from({ length: SHARDS }, (_, s) => byShard.get(s)?.[0]).filter((id): id is Id<"canonEntities"> => Boolean(id));
    const rounds = args.rounds ?? 5;
    const contention = async (ids: Id<"canonEntities">[]): Promise<SaveTimings> => {
      const latencies: number[] = [];
      const walls: number[] = [];
      for (let round = 0; round <= rounds; round++) {
        const t0 = Date.now();
        const timed = await Promise.all(ids.map(async (streamId, i) => {
          const t = Date.now();
          const status = await ctx.runMutation(internal.devObjects.benchSave, { orgId, userId, streamId, company: `Round ${round} ${i}` });
          if (status !== "applied") throw new ConvexError(`bench save returned ${status}`);
          return Date.now() - t;
        }));
        // Round 0 materializes each lead from its stream and writes its first hot row.
        if (round === 0) continue;
        walls.push(Date.now() - t0);
        latencies.push(...timed);
      }
      return { saves: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(...latencies), wallP50: percentile(walls, 50) };
    };
    const sameShardResult = await contention(sameShard);
    const spreadResult = await contention(spread);

    return {
      import: {
        records: streamIds.length,
        seconds: importSeconds,
        recordsPerSecond: Math.round(streamIds.length / importSeconds),
        batchMs: { p50: percentile(batchMs, 50), p95: percentile(batchMs, 95), max: Math.max(...batchMs) },
        emptyBatchMs,
      },
      replay: { records: replay.length, unchanged: replay.filter((r) => r.result.status === "unchanged").length, ms: replayMs },
      contention: { sameShard: { streams: sameShard.length, ...sameShardResult }, differentShards: { streams: spread.length, ...spreadResult } },
    };
  },
});

/** A deal's stream as the CP1d proof shows it: its latest entries, hot row, deals row and queued proposals. */
export const dealLedgerView = internalQuery({
  args: { dealId: v.id("deals"), entries: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireDev();
    const deal = await ctx.db.get(args.dealId);
    if (!deal) throw new ConvexError("Deal not found");
    const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", deal.orgId).eq("projectionId", deal._id)).first();
    if (!entity) return { deal: deal.name, stream: null };
    const entries = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entity._id)).order("desc").take(args.entries ?? 3);
    const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", deal.orgId).eq("streamId", entity._id)).unique();
    const queue = await ctx.db.query("proposalQueue").withIndex("by_orgId_observedAt", (q) => q.eq("orgId", deal.orgId)).take(100);
    const row = deal as unknown as Record<string, unknown>;
    return {
      deal: deal.name,
      stream: entity._id,
      entries: entries.map((e) => ({ version: e.version, shard: e.shard, seq: e.seq, source: `${e.source.kind}:${e.source.ref}`, body: e.body })),
      hotRow: hot && { version: hot.version, values: Object.fromEntries(DEAL_ATTRIBUTES.map((a) => [a, hot.values[a] ?? null])) },
      dealsRow: Object.fromEntries(DEAL_ATTRIBUTES.map((a) => [a, row[a] ?? null])),
      proposalQueue: queue.filter((p) => p.streamId === entity._id).map((p) => ({ fieldId: p.fieldId, factId: p.factId })),
    };
  },
});

/** Edit a deal's next step through the public `deals.updateNextStep` mutation, twice, and show what the ledger holds. */
export const dealEditProof = internalAction({
  args: { dealId: v.id("deals"), nextStep: v.string() },
  handler: async (ctx, args): Promise<{ edits: unknown[]; view: unknown }> => {
    requireDev();
    const edits = [];
    for (let i = 0; i < 2; i++) edits.push(await ctx.runMutation(api.deals.updateNextStep, args));
    return { edits, view: await ctx.runQuery(internal.devObjects.dealLedgerView, { dealId: args.dealId, entries: 2 }) };
  },
});

/** An account's or contact's stream as the CP2a proof shows it, found by any of its external ids. */
export const partyLedgerView = internalQuery({
  args: { orgId: v.id("organizations"), provider: v.string(), externalId: v.string(), entries: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireDev();
    const ext = await ctx.db.query("canonExternalIds")
      .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", args.orgId).eq("provider", args.provider).eq("externalId", args.externalId))
      .first();
    if (!ext) return null;
    const ids = await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", ext.entityId)).take(20);
    const entries = await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", ext.entityId)).order("desc").take(args.entries ?? 3);
    const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", args.orgId).eq("streamId", ext.entityId)).unique();
    const facts = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", ext.entityId)).take(50);
    return {
      stream: ext.entityId,
      externalIds: ids.map((x) => `${x.provider}=${x.externalId}`),
      entries: entries.map((e) => ({ version: e.version, shard: e.shard, seq: e.seq, source: `${e.source.kind}:${e.source.ref}`, body: e.body })),
      hotRow: hot && { object: hot.object, version: hot.version, title: hot.title, values: Object.fromEntries(Object.entries(hot.values).filter(([, x]) => x !== null)) },
      canonFieldState: Object.fromEntries(facts.map((f) => [f.attribute, f.value])),
    };
  },
});

/**
 * Edit a TAM account through the public `records.edit` action, as the
 * account page does, and show the ledger entry, the hot row and the
 * record-service row it wrote. Needs the TAM seed (devSeed:seedTam).
 */
export const accountEditProof = internalAction({
  args: { domain: v.string(), patch: v.record(v.string(), v.union(v.string(), v.number(), v.null())) },
  handler: async (ctx, args): Promise<{ recordId: string; edit: unknown; recordService: unknown; ledger: unknown }> => {
    requireDev();
    const { orgId }: { orgId: Id<"organizations"> } = await ctx.runQuery(internal.devObjects.devCaller, {});
    const client = clientFor(ctx);
    const page = await client.list(orgId, { filter: { q: args.domain }, limit: 10 });
    const row = page.rows.find((r) => r.domain === args.domain);
    if (!row) throw new ConvexError(`No TAM account ${args.domain}; run devSeed:seedTam`);
    const edit = await ctx.runAction(api.records.edit, { object: "account", id: row.id, patch: args.patch, idempotencyKey: `proof:${Date.now()}` });
    const after = await client.get(orgId, row.id);
    const picked = after && Object.fromEntries(Object.keys(args.patch).map((k) => [k, (after.account as Record<string, unknown>)[k] ?? null]));
    return {
      recordId: row.id,
      edit,
      recordService: after && { ...picked, version: after.account.version },
      ledger: await ctx.runQuery(internal.devObjects.partyLedgerView, { orgId, provider: "record:account", externalId: row.id, entries: 4 }),
    };
  },
});

type Spread = { p50: number; p95: number; max: number };
const spread = (xs: number[]): Spread => ({ p50: percentile(xs, 50), p95: percentile(xs, 95), max: Math.max(...xs) });

/**
 * CP1f measurements against a record service in projector mode
 * (RECORD_SERVICE_URL set on this local deployment). `saves` single lead
 * creates, each followed by list calls until the new row is listed: save is the
 * mutation's round trip, lag is from its return until the row is listed. Then
 * `listRuns` list calls from this action, to time the action to service round
 * trip on its own.
 */
export const benchProjector = internalAction({
  args: { saves: v.optional(v.number()), listRuns: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ saves: number; saveMs: Spread; lagMs: Spread; totalMs: Spread; pollsP50: number; listRoundTripMs: Spread; listedRows: number }> => {
    requireDev();
    const client = recordClient();
    if (client.mode !== "http") throw new ConvexError("Set RECORD_SERVICE_URL on this deployment first");
    const { orgId }: { orgId: Id<"organizations"> } = await ctx.runQuery(internal.devObjects.devCaller, {});
    const run = Date.now().toString(36);
    const saveMs: number[] = [];
    const lagMs: number[] = [];
    const totalMs: number[] = [];
    const polls: number[] = [];
    const n = args.saves ?? 30;
    // Save 0 warms the path (scheduler, workspace open, first tail) and is not counted.
    for (let i = 0; i <= n; i++) {
      const t0 = Date.now();
      const saved: SaveResult = await ctx.runMutation(api.objects.write, { object: "lead", values: { lastName: `Lag ${run} ${i}`, status: "new" } });
      if (saved.status !== "applied") throw new ConvexError(`save returned ${saved.status}`);
      const t1 = Date.now();
      let tries = 0;
      for (;;) {
        tries++;
        const page = await client.listObjects(orgId, "lead", { filter: [{ field: "id", op: "eq", value: saved.streamId }], limit: 1 });
        if (page.rows.length === 1) break;
        if (Date.now() - t1 > 10_000) throw new ConvexError(`lead ${saved.streamId} not listed within 10 s`);
      }
      const t2 = Date.now();
      if (i === 0) continue;
      saveMs.push(t1 - t0);
      lagMs.push(t2 - t1);
      totalMs.push(t2 - t0);
      polls.push(tries);
    }
    const listRoundTripMs: number[] = [];
    let listedRows = 0;
    for (let i = 0; i < (args.listRuns ?? 30); i++) {
      const t = Date.now();
      const page = await client.listObjects(orgId, "product", { filter: [{ field: "family", op: "eq", value: "Family 3" }, { field: "active", op: "eq", value: true }], sort: { field: "unitPrice", dir: "desc" }, limit: 50 });
      listRoundTripMs.push(Date.now() - t);
      listedRows = page.total;
    }
    return { saves: n, saveMs: spread(saveMs), lagMs: spread(lagMs), totalMs: spread(totalMs), pollsP50: percentile(polls, 50), listRoundTripMs: spread(listRoundTripMs), listedRows };
  },
});

/**
 * Import `total` products in batches of 100, one batch at a time, with
 * families, prices and an active flag spread for list filters. Products are
 * the list bench's table because a fresh local stack has none, so p_product
 * holds exactly the rows seeded here.
 */
export const seedProducts = internalAction({
  args: { total: v.number() },
  handler: async (ctx, args): Promise<{ imported: number; seconds: number }> => {
    requireDev();
    const { orgId }: { orgId: Id<"organizations"> } = await ctx.runQuery(internal.devObjects.devCaller, {});
    const sourceRef = `seed:${Date.now()}`;
    const started = Date.now();
    let imported = 0;
    for (let offset = 0; offset < args.total; offset += 100) {
      const records = Array.from({ length: Math.min(100, args.total - offset) }, (_, i) => {
        const k = offset + i;
        return {
          externalId: `seed-${k}`,
          values: { name: `Product ${k}`, family: `Family ${k % 20}`, unitPrice: ((k * 7919) % 10_000) / 10, active: k % 3 !== 0 },
          createdAt: 1_700_000_000_000 + k,
        };
      });
      const { results }: { results: Array<{ result: SaveResult }> } = await ctx.runMutation(internal.objects.importBatch, { orgId, object: "product", sourceRef, actorId: "seed", records });
      imported += results.filter((r) => r.result.status === "applied").length;
    }
    return { imported, seconds: (Date.now() - started) / 1000 };
  },
});
