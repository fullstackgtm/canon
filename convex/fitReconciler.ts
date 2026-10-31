import { v } from "convex/values";
import { internalAction, internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { readIcps } from "./lib/icpsInterface";
import { modelSettings } from "./lib/recipes";
import { specGate } from "./lib/icps";
import { specToIcp } from "./lib/addRecords";
import { icpToWeights } from "./lib/researchPipeline";
import { fitState, invalidateFit } from "./lib/fitInvalidation";
import { completeWeights, legacyVersion, recordVersion } from "./icpVersions";
import { icpVersionWeightsValidator } from "./lib/scoreHistory";
import type { IcpGate } from "./lib/recordContract";
import type { IcpVersionWeights } from "./lib/scoreHistory";
import { clientFor } from "./records";
import { atLeastVersion } from "./lib/recordClient";

const RETRY_MS = 60_000;
const orgArgs = { orgId: v.id("organizations") };
const attemptArgs = { ...orgArgs, generation: v.number() };
type Snapshot = { version: number; weights: IcpVersionWeights; gates: IcpGate[]; generation: number };

export const request = internalMutation({
  args: orgArgs,
  handler: async (ctx, { orgId }): Promise<number> => (await invalidateFit(ctx, orgId)).generation,
});

/** Local demo weight edits are configuration writes too. Active definitions still own their gates. */
export const setFallback = internalMutation({
  args: { ...orgArgs, weights: icpVersionWeightsValidator },
  handler: async (ctx, { orgId, weights }): Promise<void> => {
    const row = await invalidateFit(ctx, orgId);
    await ctx.db.patch(row._id, { fallbackWeights: weights });
  },
});

async function prepareSnapshot(ctx: MutationCtx, { orgId, generation }: { orgId: Id<"organizations">; generation: number }): Promise<Snapshot | null> {
  const row = await fitState(ctx, orgId);
  if (!row?.queued || row.generation !== generation) return null;
  let pending = row.pending;
  if (!pending) {
    // Compilation and allocation share the transaction, so an old read cannot acquire a newer version.
    const active = (await readIcps(ctx, orgId)).filter((r) => r.active).sort((a, b) => a.key.localeCompare(b.key));
    const fit = await modelSettings(ctx, orgId, "scoring.fit");
    const latest = await ctx.db.query("icpVersions").withIndex("by_orgId_and_version", (q) => q.eq("orgId", orgId)).order("desc").first();
    const lead = active.find((a) => a.isDefault) ?? active[0];
    const weights = lead ? completeWeights(icpToWeights(specToIcp(lead.spec.market, lead.spec.persona), fit))
      : row.fallbackWeights ?? latest?.weights ?? (await legacyVersion(ctx, orgId))?.weights ?? completeWeights({ base: fit.base });
    const version = await recordVersion(ctx, { orgId, weights, gates: active.map((a) => specGate(a.key, a.spec, fit)) });
    if (row.fallbackWeights) await ctx.db.patch(row._id, { fallbackWeights: undefined });
    if (row.acknowledgedVersion === version) {
      await ctx.db.patch(row._id, { acknowledgedRevision: row.revision, queued: false });
      return null;
    }
    pending = { revision: row.revision, version };
  }
  const snapshot = await ctx.db.query("icpVersions").withIndex("by_orgId_and_version", (q) => q.eq("orgId", orgId).eq("version", pending.version)).unique();
  if (!snapshot) throw new Error("Fit snapshot missing");
  await ctx.db.patch(row._id, { pending });
  return { version: snapshot.version, weights: snapshot.weights, gates: snapshot.gates ?? [], generation };
}

export const prepare = internalMutation({ args: attemptArgs, handler: prepareSnapshot });

async function claimAttempt(ctx: MutationCtx, { orgId, generation }: { orgId: Id<"organizations">; generation: number }): Promise<number | null> {
  const row = await fitState(ctx, orgId);
  if (!row?.queued || row.generation !== generation) return null;
  const next = generation + 1;
  // Arm recovery before compilation too: a temporarily unavailable provider must remain stale.
  await ctx.scheduler.runAfter(RETRY_MS, internal.fitReconciler.reconcile, { orgId, generation: next });
  await ctx.db.patch(row._id, { generation: next });
  return next;
}

export const claim = internalMutation({ args: attemptArgs, handler: claimAttempt });

export const begin = internalMutation({
  args: orgArgs,
  handler: async (ctx, { orgId }): Promise<Snapshot | null> => {
    const row = await fitState(ctx, orgId);
    if (!row?.queued) return null;
    const generation = await claimAttempt(ctx, { orgId, generation: row.generation });
    return generation === null ? null : prepareSnapshot(ctx, { orgId, generation });
  },
});

export const acknowledge = internalMutation({
  args: { ...attemptArgs, version: v.number() },
  handler: async (ctx, { orgId, generation, version }): Promise<void> => {
    const row = await fitState(ctx, orgId);
    if (!row?.pending || row.generation !== generation || row.pending.version !== version) return;
    const more = row.revision > row.pending.revision;
    const next = generation + 1;
    await ctx.db.patch(row._id, {
      acknowledgedRevision: row.pending.revision, acknowledgedVersion: version, pending: undefined, queued: more, generation: next,
    });
    if (more) await ctx.scheduler.runAfter(0, internal.fitReconciler.reconcile, { orgId, generation: next });
  },
});

async function send(ctx: ActionCtx, orgId: Id<"organizations">, generation: number): Promise<{ rescored: number }> {
  const claimed: number | null = await ctx.runMutation(internal.fitReconciler.claim, { orgId, generation });
  if (claimed === null) return { rescored: 0 };
  const snapshot: Snapshot | null = await ctx.runMutation(internal.fitReconciler.prepare, { orgId, generation: claimed });
  if (!snapshot) return { rescored: 0 };
  return sendSnapshot(ctx, orgId, snapshot);
}

async function sendSnapshot(ctx: ActionCtx, orgId: Id<"organizations">, snapshot: Snapshot): Promise<{ rescored: number }> {
  const client = clientFor(ctx);
  // Older services replace blindly. Leave the durable request pending until the contract is available.
  if (!atLeastVersion(await client.contractVersion(), "1.41.0")) throw new Error("Fit reconciliation requires record service 1.41.0");
  const result = await client.rescore(orgId, snapshot.weights, snapshot.version, snapshot.gates);
  await ctx.runMutation(internal.fitReconciler.acknowledge, { orgId, generation: snapshot.generation, version: snapshot.version });
  return result;
}

/** Used by imports that must install fit before their account upserts. The scheduled retry remains durable. */
export async function reconcileFit(ctx: ActionCtx, orgId: Id<"organizations">): Promise<{ rescored: number }> {
  await ctx.runMutation(internal.fitReconciler.request, { orgId });
  // Claim and compile together so a queued worker cannot make an import skip an unacknowledged send.
  const snapshot: Snapshot | null = await ctx.runMutation(internal.fitReconciler.begin, { orgId });
  return snapshot ? sendSnapshot(ctx, orgId, snapshot) : { rescored: 0 };
}

export const reconcile = internalAction({
  args: attemptArgs,
  handler: async (ctx, { orgId, generation }): Promise<void> => {
    await send(ctx, orgId, generation);
  },
});
