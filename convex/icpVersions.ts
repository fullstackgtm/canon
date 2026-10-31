/**
 * ICP versions (docs/signal-ledger.md, SL4): every weight set a workspace scored with, immutable. Convex
 * owns the ICP and the record service's copy can't be fetched again (its backups are off), so the
 * versions live here; the record service keeps only the active set, to score in SQL.
 */
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { Icp } from "../engine/src/icp.ts";
import { getCurrentUser } from "./lib";
import { icpToWeights } from "./lib/researchPipeline";
import { defaultModel } from "../recipes/index.ts";
import type { IcpGate, IcpWeights } from "./lib/recordContract";
import type { IcpVersion, IcpVersionWeights } from "./lib/scoreHistory";

/** Versions read for a score history, newest first. */
const VERSIONS_READ = 50;

export const completeWeights = (w: IcpWeights): IcpVersionWeights => ({ base: w.base ?? 0, industries: w.industries ?? {}, countries: w.countries ?? {}, employeeBands: w.employeeBands ?? [] });
const canonical = (w: IcpVersionWeights, gates?: IcpGate[]) =>
  JSON.stringify([w.base, Object.entries(w.industries).sort(), Object.entries(w.countries).sort(), w.employeeBands.map((b) => [b.min, b.max, b.weight]), gates ?? null]);

/** Before SL4, a workspace's weights were its claimed session's ICP, stored when it was claimed: version 1, on Canon's defaults then. */
export async function legacyVersion(ctx: QueryCtx, orgId: Id<"organizations">): Promise<IcpVersion | null> {
  const session = await ctx.db.query("researchSessions").withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", orgId)).order("desc").first();
  if (!session?.icp) return null;
  return { version: 1, acceptedAt: session.claimedAt ?? session.createdAt, weights: completeWeights(icpToWeights(session.icp as Icp, defaultModel("scoring.fit"))) };
}

const newest = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("icpVersions").withIndex("by_orgId_and_version", (q) => q.eq("orgId", orgId)).order("desc");

/** The caller's ICP versions, oldest first. A workspace that has accepted none yet shows its claimed weights as version 1. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<IcpVersion[] | null> => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const rows = await newest(ctx, user.orgId).take(VERSIONS_READ);
    if (!rows.length) {
      const legacy = await legacyVersion(ctx, user.orgId);
      return legacy ? [legacy] : [];
    }
    return rows.reverse().map(({ version, acceptedAt, weights, gates }) => ({ version, acceptedAt, weights, ...(gates?.length ? { gates } : {}) }));
  },
});

/** Store a weight set as the next version (the claimed weights become version 1 first). The latest set again is a no-op. */
export async function recordVersion(ctx: MutationCtx, args: { orgId: Id<"organizations">; weights: IcpVersionWeights; gates: IcpGate[] }): Promise<number> {
  let latest: IcpVersion | null = await newest(ctx, args.orgId).first();
  if (!latest) {
    latest = await legacyVersion(ctx, args.orgId);
    if (latest) await ctx.db.insert("icpVersions", { orgId: args.orgId, ...latest });
  }
  if (latest && canonical(latest.weights, latest.gates) === canonical(args.weights, args.gates)) return latest.version;
  const version = (latest?.version ?? 0) + 1;
  await ctx.db.insert("icpVersions", { orgId: args.orgId, version, acceptedAt: Date.now(), weights: args.weights, gates: args.gates });
  return version;
}
