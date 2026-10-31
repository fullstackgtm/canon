import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { callerClient, requireCaller } from "./records";
import { readIcps } from "./lib/icpsInterface";
import { icpMarketFilter } from "./lib/icpGap";
import { companyRootDomain } from "./lib/tam/siteExtract";
import { catalogForMarket, SOURCE_CATALOG_VERSION, type CatalogSource } from "./lib/tam/sourceCatalog";
import { rankSources, SEARCH_REFUSAL, type Seed } from "./lib/tam/marketSources";
import { sourceFactsFields, sourceMatch, sourceSeed } from "./lib/tam/marketSourcesValidator";
import { requireUser } from "./lib";
import { paidCallsAllowed } from "./lib/treg";

export const workspaceMarket = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const first = (await readIcps(ctx, orgId)).filter((i) => i.active).sort((a, b) => a.createdAt - b.createdAt)[0];
    return { icpId: first?.key ?? null, market: first ? icpMarketFilter(first.spec) ?? {} : {} };
  },
});

export const start = action({
  args: {},
  handler: async (ctx): Promise<Id<"marketSourceSearches">> => {
    const caller = await requireCaller(ctx);
    const client = callerClient(ctx, caller);
    const orgId = caller.orgId as Id<"organizations">;
    const { icpId } = await ctx.runQuery(internal.marketSources.workspaceMarket, { orgId });
    const seeds: Seed[] = [];
    const add = (account: { name: string; domain: string }) => {
      const domain = companyRootDomain(account.domain);
      if (domain && account.name.trim() && !seeds.some((s) => s.domain === domain)) seeds.push({ domain, name: account.name.trim() });
    };
    let cursor: string | undefined;
    do {
      const deals = await client.listObjects(caller.orgId, "deal", { filter: [{ field: "isWon", op: "eq", value: true }], sort: { field: "updatedAt", dir: "desc" }, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const deal of deals.rows) {
        const id = deal.values.companyId;
        if (typeof id !== "string" || !id || seeds.length >= 10) continue;
        const account = await client.get(caller.orgId, id);
        if (account) add(account.account);
      }
      cursor = deals.nextCursor ?? undefined;
    } while (cursor && seeds.length < 10);
    if (!seeds.length && icpId) {
      const accounts = await client.list(caller.orgId, { filter: { icpId }, sort: { field: "fit", dir: "desc" }, limit: 100 });
      for (const account of accounts.rows) { if (seeds.length >= 10) break; add(account); }
    }
    const reason = !paidCallsAllowed() ? SEARCH_REFUSAL : !seeds.length ? "Add accounts to an active ICP or link an account to a won deal before searching for directories." : undefined;
    return ctx.runMutation(internal.marketSources.begin, { orgId, startedBy: caller.userId as Id<"users">, seeds, ...(reason ? { reason } : {}) });
  },
});

export const view = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const run = await ctx.db.query("marketSourceSearches").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", orgId)).order("desc").first();
    const keys = [...new Set(run?.results.map((r) => r.sourceKey) ?? [])];
    const sources = await Promise.all(keys.map((key) => ctx.db.query("marketSources").withIndex("by_key", (q) => q.eq("key", key)).unique()));
    return { run, sources: rankSources(sources.filter((s): s is Doc<"marketSources"> => s !== null)) };
  },
});

export type MarketSourcesRead = { catalogVersion: number; catalog: CatalogSource[]; run: Doc<"marketSourceSearches"> | null; sources: Doc<"marketSources">[] };

export const read = action({
  args: {},
  handler: async (ctx): Promise<MarketSourcesRead> => {
    const caller = await requireCaller(ctx, { read: true });
    const orgId = caller.orgId as Id<"organizations">;
    const data = await ctx.runQuery(internal.marketSources.view, { orgId });
    const { market } = await ctx.runQuery(internal.marketSources.workspaceMarket, { orgId });
    const visible = new Set<string>();
    const client = callerClient(ctx, caller);
    for (const seed of data.run?.seeds ?? []) {
      const page = await client.list(caller.orgId, { filter: { q: seed.domain }, limit: 20 });
      if (page.rows.some((a) => companyRootDomain(a.domain) === seed.domain && a.name === seed.name)) visible.add(seed.domain);
    }
    const results = data.run?.results.filter((r) => visible.has(r.seedDomain)) ?? [];
    return { catalogVersion: SOURCE_CATALOG_VERSION, catalog: catalogForMarket(market),
      run: data.run ? { ...data.run, seeds: data.run.seeds.filter((s) => visible.has(s.domain)), results } : null,
      sources: data.sources.filter((s) => results.some((r) => r.sourceKey === s.key)),
    };
  },
});

export const begin = internalMutation({
  args: { orgId: v.id("organizations"), startedBy: v.id("users"), seeds: v.array(sourceSeed), reason: v.optional(v.string()), investigationId: v.optional(v.id("tamInvestigations")) },
  handler: async (ctx, args) => {
    const investigation = args.investigationId ? await ctx.db.get(args.investigationId) : null;
    if (args.investigationId && (!investigation || investigation.orgId !== args.orgId || investigation.status !== "planning")) throw new ConvexError("Investigation is unavailable.");
    if (investigation?.searchId) return investigation.searchId;
    const last = await ctx.db.query("marketSourceSearches").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", args.orgId)).order("desc").first();
    if (!investigation && last?.status === "running") return last._id;
    const id = await ctx.db.insert("marketSourceSearches", { ...args, startedAt: Date.now(), status: args.reason ? "refused" : "running", results: [], calls: 0, costMicro: 0 });
    if (investigation) await ctx.db.patch(investigation._id, { searchId: id, updatedAt: Date.now() });
    if (args.reason && investigation) await ctx.scheduler.runAfter(0, internal.tamInvestigationWorker.makePlan, { investigationId: investigation._id });
    if (!args.reason) {
      await ctx.scheduler.runAfter(0, internal.marketSourcesSearch.run, { runId: id });
      await ctx.scheduler.runAfter(9 * 60_000, internal.marketSources.expire, { runId: id });
    }
    return id;
  },
});
export const load = internalQuery({ args: { runId: v.id("marketSourceSearches") }, handler: (ctx, { runId }) => ctx.db.get(runId) });
export const cached = internalQuery({ args: { key: v.string() }, handler: async (ctx, { key }) => {
  const row = await ctx.db.query("marketSources").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (!row) return null;
  return { key: row.key, url: row.url, title: row.title, kind: row.kind, markets: row.markets, lastSeenAt: row.lastSeenAt,
    ...(row.listedCount !== undefined ? { listedCount: row.listedCount } : {}),
    ...(row.filterable !== undefined ? { filterable: row.filterable } : {}),
    ...(row.exportable !== undefined ? { exportable: row.exportable } : {}),
  };
} });

export const keep = internalMutation({
  args: { runId: v.id("marketSourceSearches"), source: v.object(sourceFactsFields), match: sourceMatch },
  handler: async (ctx, { runId, source, match }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    const seed = run.seeds.find((s) => s.domain === match.seedDomain);
    if (!seed || source.key !== match.sourceKey || (!match.quote.includes(seed.name) && !match.quote.includes(seed.domain))) throw new ConvexError("Source evidence does not match this run.");
    if (run.results.some((r) => r.sourceKey === match.sourceKey && r.seedDomain === match.seedDomain)) return;
    const membership = await ctx.db.query("marketSourceMemberships").withIndex("by_sourceKey_and_seedDomain", (q) => q.eq("sourceKey", source.key).eq("seedDomain", seed.domain)).first();
    const old = await ctx.db.query("marketSources").withIndex("by_key", (q) => q.eq("key", source.key)).unique();
    if (!membership) await ctx.db.insert("marketSourceMemberships", { orgId: run.orgId, sourceKey: source.key, seedDomain: seed.domain });
    const facts = { ...source, seedHits: (old?.seedHits ?? 0) + (membership ? 0 : 1), firstSeenAt: old?.firstSeenAt ?? Date.now(), lastSeenAt: Date.now() };
    if (old) await ctx.db.replace(old._id, facts); else await ctx.db.insert("marketSources", facts);
    await ctx.db.patch(runId, { results: [...run.results, match] });
  },
});
export const recordCall = internalMutation({
  args: { runId: v.id("marketSourceSearches"), provider: v.union(v.literal("treg"), v.literal("openrouter")), endpoint: v.string(), callId: v.optional(v.string()), costMicro: v.number(), hit: v.boolean() },
  handler: async (ctx, { runId, hit, ...call }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    await ctx.db.insert("providerCalls", { ...call, orgId: run.orgId, feature: "tam_sources", outcome: hit ? "hit" : "miss", at: Date.now() });
    await ctx.db.patch(runId, { calls: run.calls + 1, costMicro: run.costMicro + call.costMicro });
  },
});
export const finish = internalMutation({
  args: { runId: v.id("marketSourceSearches"), status: v.union(v.literal("done"), v.literal("refused"), v.literal("failed")), reason: v.optional(v.string()) },
  handler: async (ctx, { runId, ...patch }) => {
    const run = await ctx.db.get(runId);
    if (run?.status !== "running") return;
    await ctx.db.patch(runId, patch);
    if (run.investigationId) await ctx.scheduler.runAfter(0, internal.tamInvestigationWorker.makePlan, { investigationId: run.investigationId });
  },
});
export const expire = internalMutation({
  args: { runId: v.id("marketSourceSearches") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (run?.status !== "running") return;
    await ctx.db.patch(runId, { status: "failed", reason: "The directory search timed out. Results found so far are saved." });
    if (run.investigationId) await ctx.scheduler.runAfter(0, internal.tamInvestigationWorker.makePlan, { investigationId: run.investigationId });
  },
});

export const previewFixture = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.CANONCRM_LOCAL_STACK !== "true" || paidCallsAllowed()) throw new ConvexError("Fixtures are available only on a local stack with paid calls off.");
    const user = await requireUser(ctx);
    const seeds = [{ name: "Atlas Cloud", domain: "atlascloud.example" }, { name: "Northstar Data", domain: "northstardata.example" }];
    const sources = [
      { key: "https://example.org/cloud-members", url: "https://example.org/cloud-members", title: "Sample cloud member directory", kind: "association" as const, listedCount: 240, filterable: true, exportable: true, markets: ["software development"], seedHits: 2 },
      { key: "https://example.org/technology-awards", url: "https://example.org/technology-awards", title: "Sample technology awards", kind: "award_list" as const, listedCount: 80, filterable: false, exportable: false, markets: ["software development"], seedHits: 1 },
    ];
    const results = [
      { sourceKey: sources[0].key, seedDomain: seeds[0].domain, quote: "Atlas Cloud is listed among our cloud infrastructure members.", query: '\"Atlas Cloud\" -site:atlascloud.example' },
      { sourceKey: sources[0].key, seedDomain: seeds[1].domain, quote: "Northstar Data is listed among our data platform members.", query: '\"Northstar Data\" -site:northstardata.example' },
      { sourceKey: sources[1].key, seedDomain: seeds[0].domain, quote: "Atlas Cloud received the technology innovation award.", query: '\"atlascloud.example\" -site:atlascloud.example' },
    ];
    const now = Date.now();
    for (const source of sources) {
      const old = await ctx.db.query("marketSources").withIndex("by_key", (q) => q.eq("key", source.key)).unique();
      const row = { ...source, firstSeenAt: now, lastSeenAt: now };
      if (old) await ctx.db.replace(old._id, row); else await ctx.db.insert("marketSources", row);
    }
    return ctx.db.insert("marketSourceSearches", { orgId: user.orgId, startedBy: user._id, startedAt: now, status: "done", reason: "Local sample results. No website searches were made.", seeds, results, calls: 0, costMicro: 0 });
  },
});
