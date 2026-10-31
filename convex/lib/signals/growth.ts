/**
 * Growth: which kinds of growth an account shows right now, from its open signals. A count of kinds, not a
 * weighted score: an account showing none is, on average, a worse prospect than one showing several.
 * Pure and free of Node imports: queries and the UI both use it. The window and counts are the workspace's
 * signals.heat model (recipes/models.ts); on Canon's defaults:
 *
 *   hiring  a role posted in the last 30 days
 *   site    the website changed in the last 30 days
 *   blog    at least two posts in the last 30 days
 *   social  profiles on at least two networks (one LinkedIn page alone is nearly universal)
 */
import type { HeatModel } from "../../../recipes/models.ts";
import type { Bucket } from "./observations";

export const GROWTH_KINDS = ["hiring", "site", "blog", "social"] as const;
export type GrowthKind = (typeof GROWTH_KINDS)[number];
export const GROWTH_LABEL: Record<GrowthKind, string> = { hiring: "Hiring", site: "Site updated", blog: "Blogging", social: "Social" };

const DAY_MS = 86_400_000;

export function growthKinds(rows: ReadonlyArray<{ bucket: Bucket; observedAt: number }>, now: number, model: HeatModel): GrowthKind[] {
  const { windowDays, blogPosts, socialProfiles } = model.growth;
  const recent = (bucket: Bucket) => rows.filter((r) => r.bucket === bucket && r.observedAt >= now - windowDays * DAY_MS && r.observedAt <= now + DAY_MS).length;
  const on: Record<GrowthKind, boolean> = {
    hiring: recent("job") > 0,
    site: recent("site") > 0,
    blog: recent("blog") >= blogPosts,
    social: rows.filter((r) => r.bucket === "social").length >= socialProfiles,
  };
  return GROWTH_KINDS.filter((kind) => on[kind]);
}
