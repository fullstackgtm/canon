/**
 * Outside-TAM fills (docs/tam-and-icps.md, step 3). When an ICP is turned on or
 * its criteria change while it's on, and when an audience starts from one, its
 * market (the shared prospect index) is compared with what the TAM holds of it.
 * A real gap starts a free fill on its own, held for review like every fill;
 * the result is kept on the ICP (`gapCheck`), so the same criteria aren't
 * refilled within a week.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { GapDecision } from "./lib/icpGap";
import { clientFor } from "./records";
import { marketView } from "./marketSize";
import { startPopulation } from "./populateActions";
import { marketQueries } from "./lib/addRecords";
import { gapDecision, gapKey, icpMarketFilter, REFILL_AFTER_MS } from "./lib/icpGap";
import { readIcps, type IcpRow } from "./lib/icpsInterface";
import { interfaceOwner } from "./lib/modules/interfaceOwnership";
import { systemScope } from "./lib/modules/scope";
import { icpGapCheckValidator } from "./lib/icpSpec";
import { isFillJob } from "./lib/runs";

/** Fills one workspace may have running at once (as addRecords). */
const MAX_RUNNING = 3;
/** Rapid edits settle before the check runs. */
const SETTLE_MS = 30_000;

/** Schedule a gap check for an ICP (after its edits settle). */
export async function scheduleGapCheck(ctx: Pick<MutationCtx, "scheduler">, orgId: Id<"organizations">, icpId: string) {
  await ctx.scheduler.runAfter(SETTLE_MS, internal.icpFills.checkGap, { orgId, icpId });
}

export async function scheduleWorkspaceGaps(ctx: Pick<MutationCtx, "scheduler">, orgId: Id<"organizations">) {
  await ctx.scheduler.runAfter(SETTLE_MS, internal.icpFills.checkWorkspace, { orgId });
}

/** Called for core and provided audience query saves. It preserves the existing array-valued ICP predicate semantics. */
export async function scheduleAudienceIcpGaps(ctx: MutationCtx, orgId: Id<"organizations">, filter: unknown) {
  if (!Array.isArray(filter)) throw new Error("An audience query must be a list of filters.");
  const ids = new Set<string>();
  for (const f of filter) {
    if (!f || typeof f !== "object" || typeof f.field !== "string" || typeof f.op !== "string") throw new Error("An audience query contains an invalid filter.");
    if (f.field !== "accountIcpIds" || !Array.isArray(f.value)) continue;
    if (!f.value.every((x: unknown) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")) throw new Error("An ICP audience predicate must contain scalar keys.");
    for (const id of f.value) ids.add(String(id));
  }
  if (!ids.size) return;
  for (const icp of await readIcps(ctx, orgId)) if (icp.active && ids.has(icp.key)) await scheduleGapCheck(ctx, orgId, icp.key);
}

type GapIcp = IcpRow & { orgId: Id<"organizations">; _id: string };
const gapArgs = { icpId: v.string(), orgId: v.optional(v.id("organizations")) };
async function loadIcp(ctx: QueryCtx, args: { icpId: string; orgId?: Id<"organizations"> }): Promise<GapIcp | null> {
  // Retained legacy schedules did not carry orgId. Only their frozen legacy id supplies it.
  const legacyId = !args.orgId && ctx.db.normalizeId("icps", args.icpId);
  const legacy = legacyId ? await ctx.db.get(legacyId) : null;
  const orgId = args.orgId ?? legacy?.orgId;
  if (!orgId) return null;
  const row = (await readIcps(ctx, orgId)).find((i) => i.key === args.icpId);
  return row ? { ...row, orgId, _id: row.key } : null;
}
async function saveResult(ctx: MutationCtx, icp: GapIcp, gapCheck: NonNullable<IcpRow["gapCheck"]>) {
  if (gapKey(icp.spec) !== gapCheck.key) return;
  if (await interfaceOwner(ctx, icp.orgId)) {
    const scope = await systemScope(ctx, icp.orgId, "@canon/icps");
    if (!scope) throw new Error("The owning ICP provider is unavailable.");
    const row = await scope.peek("icps", icp.key);
    if (row) await scope.op("recordGap", { key: icp.key, expect: row.version, data: { gapCheck } });
  } else {
    const id = ctx.db.normalizeId("icps", icp.key);
    if (id) await ctx.db.patch(id, { gapCheck });
  }
}

export const load = internalQuery({ args: gapArgs, handler: loadIcp });
export const activeKeys = internalQuery({ args: { orgId: v.id("organizations") }, handler: async (ctx, { orgId }) => (await readIcps(ctx, orgId)).filter((i) => i.active).map((i) => i.key) });
export const checkWorkspace = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const keys: string[] = await ctx.runQuery(internal.icpFills.activeKeys, { orgId });
    for (const icpId of keys) await ctx.runAction(internal.icpFills.checkGap, { orgId, icpId });
    return null;
  },
});

/**
 * Claim the fill for these criteria: false when a fill for them already started in the last week, or the
 * workspace already runs MAX_RUNNING fills (then the check is kept as busy and retried on the next change).
 * One transaction, so of two overlapping checks only one claims.
 */
export const claim = internalMutation({
  args: { ...gapArgs, gapCheck: icpGapCheckValidator },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const icp = await loadIcp(ctx, args);
    if (!icp?.active || gapKey(icp.spec) !== args.gapCheck.key) return false;
    const last = icp.gapCheck;
    if (last && last.key === args.gapCheck.key && last.outcome === "filling" && Date.now() - last.at < REFILL_AFTER_MS) return false;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await ctx.db.query("backgroundJobs")
      .withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", icp.orgId).gte("startedAt", since))
      .take(50);
    if (recent.filter((j) => isFillJob(j) && j.status === "processing").length >= MAX_RUNNING) {
      await saveResult(ctx, icp, { ...args.gapCheck, outcome: "busy" });
      return false;
    }
    await saveResult(ctx, icp, args.gapCheck);
    return true;
  },
});

export const record = internalMutation({
  args: { ...gapArgs, gapCheck: icpGapCheckValidator },
  handler: async (ctx, args) => {
    const icp = await loadIcp(ctx, args);
    if (icp) await saveResult(ctx, icp, args.gapCheck);
    return null;
  },
});

/**
 * Compare an active ICP's market with the TAM's share of it, and fill the gap when it's real.
 * `dryRun` reports the decision without starting anything (for checking it on a stack).
 */
export type GapCheckResult = {
  skipped?: "inactive" | "recent" | "unnarrowed" | "unavailable" | "busy";
  market?: number;
  tam?: number;
  decision?: GapDecision;
  jobId?: Id<"backgroundJobs">;
};

export const checkGap = internalAction({
  args: { ...gapArgs, dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<GapCheckResult> => {
    const icp: GapIcp | null = await ctx.runQuery(internal.icpFills.load, { icpId: args.icpId, ...(args.orgId ? { orgId: args.orgId } : {}) });
    if (!icp?.active) return { skipped: "inactive" };
    const key = gapKey(icp.spec);
    const last = icp.gapCheck;
    if (!args.dryRun && last && last.key === key && last.outcome !== "unavailable" && last.outcome !== "busy" && Date.now() - last.at < REFILL_AFTER_MS) {
      return { skipped: "recent" as const };
    }
    const filter = icpMarketFilter(icp.spec);
    if (!filter) return { skipped: "unnarrowed" as const };
    const base = { key, at: Date.now() };

    let market: number;
    try {
      market = (await marketView(ctx, filter, "sizeBand")).total;
    } catch {
      if (!args.dryRun) await ctx.runMutation(internal.icpFills.record, { icpId: icp.key, orgId: icp.orgId, gapCheck: { ...base, market: 0, tam: 0, outcome: "unavailable" } });
      return { skipped: "unavailable" as const };
    }
    const tam: number = (await clientFor(ctx).countSegment(icp.orgId, filter)).total;
    const decision = gapDecision(market, tam);
    if (args.dryRun) return { market, tam, decision };

    if (!decision.fill) {
      await ctx.runMutation(internal.icpFills.record, { icpId: icp.key, orgId: icp.orgId, gapCheck: { ...base, market, tam, outcome: decision.reason } });
      return { market, tam, decision };
    }
    if (!process.env.TREG_TOKEN) {
      await ctx.runMutation(internal.icpFills.record, { icpId: icp.key, orgId: icp.orgId, gapCheck: { ...base, market, tam, outcome: "unavailable" } });
      return { market, tam, decision, skipped: "unavailable" };
    }
    // Reserve the fill in one transaction: overlapping checks (rapid edits, several audiences) start one fill.
    const claimed: boolean = await ctx.runMutation(internal.icpFills.claim, { icpId: icp.key, orgId: icp.orgId, gapCheck: { ...base, market, tam, outcome: "filling" } });
    if (!claimed) return { market, tam, decision, skipped: "busy" };
    const q = marketQueries(icp.spec.market, icp.spec.persona, icp.spec.exclude);
    const jobId: Id<"backgroundJobs"> = await startPopulation(ctx, undefined, icp.orgId, [{ kind: "people", source: "quickenrich", query: q.quickenrich }], {
      title: `Fill ${icp.name}`,
      detail: `About ${decision.gap.toLocaleString("en-US")} companies in this ICP aren't in your CRM yet…`,
    }, { stage: true });
    await ctx.runMutation(internal.icpFills.record, { icpId: icp.key, orgId: icp.orgId, gapCheck: { ...base, market, tam, outcome: "filling", jobId } });
    return { market, tam, decision, jobId };
  },
});
