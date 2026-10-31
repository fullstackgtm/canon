import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { Snapshot } from "./scope";
import type { ReadValue } from "../../../modules/kernel/calls.ts";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { superseded } from "./revision";

/** Bound requests and transactional inputs, before any action fills their results. */
export function actionReadFence(snap: Snapshot): string {
  return canonicalJson({ principal: snap.principalFence ?? null, revision: snap.revision, reads: snap.reads, records: snap.records ?? {}, web: snap.webPages ?? {}, webSearches: snap.webSearches ?? {}, samples: snap.marketSamples ?? {}, me: snap.meContexts ?? {}, social: snap.socialSearches ?? {}, companies: snap.dealCompanies ?? {} });
}

export async function readActionSources(ctx: ActionCtx, module: string, snap: Snapshot, reads: Record<string, ReadValue>, fresh: () => Promise<Snapshot>, explicit = true) {
  const fence = actionReadFence(snap);
  for (const [name, request] of Object.entries(snap.meContexts ?? {})) {
    if (!explicit) throw new ConvexError("Personal context requires an explicit member call, never printing or exports.");
    if (request.userId !== snap.caller.userId) throw new ConvexError("The personal context principal changed.");
    if (actionReadFence(await fresh()) !== fence) throw superseded();
    reads[name] = await ctx.runAction(internal.moduleMeActions.context, { ...request, orgId: request.orgId as Id<"organizations">, userId: request.userId as Id<"users"> });
  }
  for (const request of Object.values(snap.socialSearches ?? {})) {
    if (!explicit) throw new ConvexError("Social searches require an explicit member call.");
    if (request.userId !== snap.caller.userId) throw new ConvexError("The social read principal changed.");
    if (actionReadFence(await fresh()) !== fence) throw superseded();
  }
  const searches = Object.entries(snap.socialSearches ?? {});
  if (searches.length) {
    const results = await ctx.runAction(internal.moduleSocialActions.search, {
      orgId: searches[0][1].orgId as Id<"organizations">, userId: snap.caller.userId as Id<"users">, module,
      searches: searches.map(([, { source, query, limit }]) => ({ source, query, limit })),
    });
    searches.forEach(([name], i) => { reads[name] = results[i]; });
  }
  for (const [name, request] of Object.entries(snap.webSearches ?? {})) {
    if (!explicit) throw new ConvexError("Web searches require an explicit member call, never printing or exports.");
    if (request.userId !== snap.caller.userId) throw new ConvexError("The web search principal changed.");
    if (actionReadFence(await fresh()) !== fence) throw superseded();
    reads[name] = await ctx.runAction(internal.moduleWebActions.search, { queries: request.queries, userId: request.userId as Id<"users"> });
  }
  for (const [name, request] of Object.entries(snap.webPages ?? {})) {
    if (!explicit) throw new ConvexError("Public websites are read only by explicit calls, never by printing or exports.");
    if (request.userId !== snap.caller.userId) throw new ConvexError("The web read principal changed.");
    if (actionReadFence(await fresh()) !== fence) throw superseded();
    const input = request.urls ? { urls: request.urls } : { domain: request.domain! };
    reads[name] = await ctx.runAction(internal.moduleWebActions.pages, input);
  }
  for (const [name, request] of Object.entries(snap.marketSamples ?? {})) {
    if (!explicit) throw new ConvexError("Free market samples require an explicit call.");
    if (request.userId !== snap.caller.userId) throw new ConvexError("The sample read principal changed.");
    if (actionReadFence(await fresh()) !== fence) throw superseded();
    reads[name] = await ctx.runAction(internal.moduleWebActions.sample, { ...request, orgId: request.orgId as Id<"organizations">, userId: request.userId as Id<"users">, module });
  }
}
