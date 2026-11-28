import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { FIRST_PARTY_MARKDOWN } from "../../recipes/_bundles.generated.ts";
import { fromManifest, toManifest } from "../../recipes/manifest.ts";
import { parseRecipe } from "../../recipes/md/parse.ts";
import { enabledFor, orgRecipe } from "./recipes";
import { merge3 } from "../../recipes/merge.ts";

export type PageTarget = { point: string; key: string };
export const targetFor = (object: string): PageTarget => ["account", "contact", "deal"].includes(object)
  ? { point: `${object}.page`, key: "page" } : { point: "workspace.pages", key: object };
export const ownLayers = (ctx: Pick<QueryCtx, "db">, user: Doc<"users">) => ctx.db.query("pageLayers")
  .withIndex("by_orgId_and_userId_and_target_point_and_target_key", (q) => q.eq("orgId", user.orgId).eq("userId", user._id)).take(20);
export const ownLayer = (ctx: Pick<QueryCtx, "db">, user: Doc<"users">, target: PageTarget) => ctx.db.query("pageLayers")
  .withIndex("by_orgId_and_userId_and_target_point_and_target_key", (q) => q.eq("orgId", user.orgId).eq("userId", user._id).eq("target.point", target.point).eq("target.key", target.key)).unique();

export async function pageBase(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, recipeId: string, target?: PageTarget) {
  if (target?.point === "deal.page") recipeId = (await orgRecipe(ctx, orgId)).recipe.id;
  else if (target?.point === "account.page" || target?.point === "contact.page" || target?.point === "workspace.pages") {
    recipeId = (await enabledFor(ctx, orgId, target.point)).find((e) => e.contribution.key === target.key)?.recipe.id ?? recipeId;
  }
  const first = (FIRST_PARTY_MARKDOWN as Record<string, string>)[recipeId];
  if (first) return { recipeId, markdown: first, revision: null };
  for await (const row of ctx.db.query("recipeMarkdownRevisions").withIndex("by_orgId_and_recipeId_and_revision", (q) => q.eq("orgId", orgId).eq("recipeId", recipeId)).order("desc")) {
    if (row.status === "current") return { recipeId, markdown: row.markdown, revision: row.revision };
  }
  throw new ConvexError("This page has no editable markdown. Customize its package first.");
}

export function rebaseLayer(layer: Pick<Doc<"pageLayers">, "baseMarkdown" | "markdown">, current: string) {
  const merged = merge3(layer.baseMarkdown, layer.markdown, current, "workspace");
  return { markdown: merged.conflicts ? layer.markdown : merged.text, conflict: merged.conflicts > 0, merge: merged.text };
}

export async function personalPage(ctx: Pick<QueryCtx, "db">, user: Doc<"users">, target: PageTarget, recipeId: string) {
  const layer = await ownLayer(ctx, user, target);
  if (!layer) return null;
  const base = await pageBase(ctx, user.orgId, recipeId, target);
  const resolved = rebaseLayer(layer, base.markdown);
  return { ...resolved, basePages: (parseRecipe(base.markdown).recipe.workspacePages ?? []).map((p) => p.slug), layerId: layer._id, revision: layer.revision, recipe: fromManifest(toManifest(parseRecipe(resolved.markdown).recipe)) };
}
